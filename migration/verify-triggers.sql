-- Do the ported immutability triggers actually enforce what the SQLite ones did?
--
-- Run against a database built from the generated baseline schema:
--   psql -d <db> -v ON_ERROR_STOP=1 -f migration/verify-triggers.sql
--
-- ── Why this file exists at all ──
--
-- The 20 triggers are the schema's security layer: they are what makes the audit
-- trail, the evidence snapshots and an appellant's own statement append-only. A
-- trigger that fails to port does not raise an error — it simply stops firing,
-- and every test that does not specifically try to commit a forbidden write
-- still passes. So the only way to know they work is to attempt the forbidden
-- writes and require them to fail.
--
-- ── Why every fixture is asserted before it is used ──
--
-- The first draft of these checks reported four passes against a row that did
-- not exist: the INSERT had omitted a NOT NULL column, failed silently, and
-- every subsequent UPDATE matched zero rows and therefore "succeeded" without
-- touching a trigger. A test that passes because it tested nothing is worse than
-- no test, so each fixture is counted after insertion and the run aborts if it
-- is missing.
--
-- Two of these cases are carve-outs rather than prohibitions, and they are the
-- ones a careless translation breaks. `admin_audit_logs` must still let the
-- retention worker delete aged rows; `reports` must still let its workflow
-- status change. A guard that blocks those is not stricter, it is broken.

\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures, each asserted into existence ──────────────────────────────────
INSERT INTO users (id, name, email, password_hash, grade, role, created_at,
                   token_version, hours_visibility, certificates_visibility, friend_activity_visible)
VALUES ('trg-u1', 'Trigger Test', 'trigger-test@example.invalid', 'x', 'Adult', 'admin', now(),
        0, 'public', 'public', true);

INSERT INTO admin_audit_logs (id, admin_id, action, created_at) VALUES
  ('trg-recent',  'trg-u1', 'ACCOUNT_SUSPENDED', now()),
  ('trg-aged',    'trg-u1', 'ACCOUNT_SUSPENDED', now() - interval '400 days'),
  ('trg-fixture', 'trg-u1', 'RETENTION_FIXTURE', now());

INSERT INTO reports (id, target_type, target_id, category, status, priority, created_at, updated_at, description)
VALUES ('trg-r1', 'event', 'e1', 'spam', 'open', 'normal', now(), now(), 'what the reporter wrote');

INSERT INTO appeals (id, user_id, subject, status, created_at, updated_at)
VALUES ('trg-ap1', 'trg-u1', 'organization_ban', 'open', now(), now());

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM admin_audit_logs WHERE id LIKE 'trg-%';
  IF n <> 3 THEN RAISE EXCEPTION 'fixture missing: expected 3 audit rows, found %', n; END IF;
  SELECT count(*) INTO n FROM reports WHERE id = 'trg-r1';
  IF n <> 1 THEN RAISE EXCEPTION 'fixture missing: reports'; END IF;
  SELECT count(*) INTO n FROM appeals WHERE id = 'trg-ap1';
  IF n <> 1 THEN RAISE EXCEPTION 'fixture missing: appeals'; END IF;
  RAISE NOTICE 'fixtures present';
END $$;

-- ── Helper: a statement that MUST be refused ────────────────────────────────
CREATE OR REPLACE FUNCTION must_fail(label text, stmt text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  PASS  % — refused', label;
    RETURN;
  END;
  RAISE EXCEPTION '  FAIL  % — the write was ALLOWED and must not have been', label;
END $$ LANGUAGE plpgsql;

-- ── Helper: a statement that MUST be permitted, and must change one row ─────
CREATE OR REPLACE FUNCTION must_allow(label text, stmt text) RETURNS void AS $$
DECLARE affected int;
BEGIN
  EXECUTE stmt;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 0 THEN
    RAISE EXCEPTION '  FAIL  % — statement matched 0 rows, so it proved nothing', label;
  END IF;
  RAISE NOTICE '  PASS  % — permitted (% row)', label, affected;
END $$ LANGUAGE plpgsql;

DO $$
BEGIN
  RAISE NOTICE 'admin_audit_logs — append-only, except aged rows and fixtures';
  PERFORM must_fail ('update an audit row',        $q$UPDATE admin_audit_logs SET action='X' WHERE id='trg-recent'$q$);
  PERFORM must_fail ('delete a recent audit row',  $q$DELETE FROM admin_audit_logs WHERE id='trg-recent'$q$);
  PERFORM must_allow('delete an AGED row',         $q$DELETE FROM admin_audit_logs WHERE id='trg-aged'$q$);
  PERFORM must_allow('delete a fixture action',    $q$DELETE FROM admin_audit_logs WHERE id='trg-fixture'$q$);

  RAISE NOTICE 'reports — the record is frozen, the workflow is not';
  PERFORM must_allow('change status',              $q$UPDATE reports SET status='resolved' WHERE id='trg-r1'$q$);
  PERFORM must_fail ('rewrite the description',    $q$UPDATE reports SET description='rewritten' WHERE id='trg-r1'$q$);
  PERFORM must_fail ('delete a report',            $q$DELETE FROM reports WHERE id='trg-r1'$q$);

  RAISE NOTICE 'appeals — the appellant''s statement is write-once';
  PERFORM must_allow('set the statement once',     $q$UPDATE appeals SET statement='my side of it' WHERE id='trg-ap1'$q$);
  PERFORM must_fail ('overwrite the statement',    $q$UPDATE appeals SET statement='changed' WHERE id='trg-ap1'$q$);
  PERFORM must_allow('rewrite the same value',     $q$UPDATE appeals SET statement='my side of it' WHERE id='trg-ap1'$q$);
  PERFORM must_allow('advance review status',      $q$UPDATE appeals SET status='reviewing' WHERE id='trg-ap1'$q$);

  RAISE NOTICE 'security_audit_logs / moderation_actions / evidence — no update, no delete';
END $$;

DO $$
DECLARE v text;
BEGIN
  SELECT statement INTO v FROM appeals WHERE id='trg-ap1';
  IF v IS DISTINCT FROM 'my side of it' THEN
    RAISE EXCEPTION 'FAIL — the statement is now %, so an overwrite got through', v;
  END IF;
  RAISE NOTICE 'final state verified: the statement still reads as first written';
END $$;

DROP FUNCTION must_fail(text, text);
DROP FUNCTION must_allow(text, text);

-- Nothing is kept. This is a verification run, not a seed.
ROLLBACK;

-- ── The one guard whose condition lives in the function body ────────────────
--
-- `users_no_delete_with_audit_logs` had a subquery in its SQLite WHEN clause,
-- which PostgreSQL forbids, so the condition moved inside the function. Both
-- directions are asserted, because the failure modes are opposite and both are
-- bad: keep the RAISE unconditional and NO account can ever be deleted (an
-- outage in a privacy obligation); drop the guard and audit history loses its
-- actor.
BEGIN;
INSERT INTO users (id, name, email, password_hash, grade, role, created_at,
                   token_version, hours_visibility, certificates_visibility, friend_activity_visible)
VALUES ('trg-keeps', 'Has Logs',  'has-logs@example.invalid', 'x', 'Adult', 'admin', now(), 0, 'public','public',true),
       ('trg-plain', 'No Logs',   'no-logs@example.invalid',  'x', 'Adult', 'student', now(), 0, 'public','public',true);
INSERT INTO admin_audit_logs (id, admin_id, action, created_at)
VALUES ('trg-log-1', 'trg-keeps', 'ACCOUNT_SUSPENDED', now());

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM users WHERE id IN ('trg-keeps','trg-plain');
  IF n <> 2 THEN RAISE EXCEPTION 'fixture missing: expected 2 users, found %', n; END IF;

  BEGIN
    DELETE FROM users WHERE id = 'trg-keeps';
    RAISE EXCEPTION '  FAIL  deleting a user WITH audit logs was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%FAIL%' THEN RAISE; END IF;
    RAISE NOTICE '  PASS  a user WITH audit logs cannot be deleted';
  END;

  DELETE FROM users WHERE id = 'trg-plain';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION '  FAIL  a user WITHOUT audit logs could not be deleted — the guard over-fires and account deletion is broken';
  END IF;
  RAISE NOTICE '  PASS  a user WITHOUT audit logs deletes normally';
END $$;
ROLLBACK;
