-- Do the generated PostgreSQL constraints enforce what SQLite's did?
--
--   psql -d <db> -v ON_ERROR_STOP=1 -f migration/verify-constraints.sql
--
-- ── Why this is separate from verify-triggers.sql ──
--
-- That file proves the immutability triggers fire. This one proves the quieter
-- half of the schema: unique constraints, foreign keys and cascade behaviour.
-- Those are what hold several of the migration's invariants — application
-- uniqueness, notification dedupe, one badge per user — and unlike the triggers
-- they produce no error when they are missing. A dropped UNIQUE does not fail
-- loudly; it silently starts admitting duplicates.
--
-- Phase 5 established that the schema APPLIES. This establishes that it
-- ENFORCES, which is a different claim and the one that matters.

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION must_fail(label text, stmt text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  PASS  % — refused', label;
    RETURN;
  END;
  RAISE EXCEPTION '  FAIL  % — was ALLOWED and must not have been', label;
END $$ LANGUAGE plpgsql;

-- ── Fixtures, asserted into existence ────────────────────────────────────────
INSERT INTO users (id, name, email, password_hash, grade, role, created_at,
                   token_version, hours_visibility, certificates_visibility, friend_activity_visible)
VALUES ('c-u1', 'One', 'c-one@example.invalid', 'x', '11', 'student', now(), 0, 'public', 'public', true),
       ('c-u2', 'Two', 'c-two@example.invalid', 'x', '11', 'student', now(), 0, 'public', 'public', true);

INSERT INTO events (id, title, description, category, location, organizer_id,
                    application_deadline, status, created_at)
VALUES ('c-e1', 'Event', 'A description', 'Other', 'Somewhere', 'c-u1',
        now() + interval '30 days', 'open', now());

INSERT INTO slots (id, event_id, name, description, max_spots, start_datetime, end_datetime)
VALUES ('c-s1', 'c-e1', 'Shift', 'A shift', 2,
        now() + interval '31 days', now() + interval '31 days' + interval '2 hours');

INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
VALUES ('c-a1', 'c-u1', 'c-e1', 'c-s1', 'pending', now());

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM applications WHERE id = 'c-a1';
  IF n <> 1 THEN RAISE EXCEPTION 'fixture missing: applications'; END IF;
  SELECT count(*) INTO n FROM users WHERE id LIKE 'c-u%';
  IF n <> 2 THEN RAISE EXCEPTION 'fixture missing: users (found %)', n; END IF;
  RAISE NOTICE 'fixtures present';
END $$;

-- ── Unique constraints ───────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'unique constraints';

  -- The invariant that makes duplicate applications impossible regardless of
  -- interleaving. Survives the migration only if the constraint came across.
  PERFORM must_fail('a second application for the same (user, slot)',
    $q$INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
       VALUES ('c-a-dup', 'c-u1', 'c-e1', 'c-s1', 'pending', now())$q$);

  -- Case-insensitive account identity. Phase 5 translated COLLATE NOCASE into a
  -- unique index on lower(email); if that were dropped, Leo@x and leo@x become
  -- two accounts.
  PERFORM must_fail('an email differing only in case',
    $q$INSERT INTO users (id, name, email, password_hash, grade, role, created_at,
                          token_version, hours_visibility, certificates_visibility, friend_activity_visible)
       VALUES ('c-u3', 'Three', 'C-ONE@EXAMPLE.INVALID', 'x', '11', 'student', now(), 0, 'public', 'public', true)$q$);
END $$;

DO $$
DECLARE n int;
BEGIN
  -- A different user for the same slot must still be allowed: the constraint is
  -- on the pair, not on the slot.
  INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
  VALUES ('c-a2', 'c-u2', 'c-e1', 'c-s1', 'pending', now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION '  FAIL  a second USER could not apply to the same slot'; END IF;
  RAISE NOTICE '  PASS  a different user may apply to the same slot';
END $$;

-- ── Foreign keys ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'foreign keys';
  PERFORM must_fail('an application referencing a user that does not exist',
    $q$INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
       VALUES ('c-a-bad', 'nobody', 'c-e1', 'c-s1', 'pending', now())$q$);
  PERFORM must_fail('a slot referencing an event that does not exist',
    $q$INSERT INTO slots (id, event_id, name, description, max_spots, start_datetime, end_datetime)
       VALUES ('c-s-bad', 'no-such-event', 'x', 'y', 1, now(), now())$q$);
END $$;

-- ── Cascade behaviour ────────────────────────────────────────────────────────
--
-- `ON DELETE CASCADE` is the half of referential integrity that fails silently
-- in the other direction: if it did NOT come across, deleting a user leaves
-- orphaned applications behind rather than raising anything.
DO $$
DECLARE before_n int; after_n int;
BEGIN
  RAISE NOTICE 'cascade behaviour';

  SELECT count(*) INTO before_n FROM applications WHERE user_id = 'c-u2';
  IF before_n = 0 THEN RAISE EXCEPTION 'fixture missing: c-u2 has no applications to cascade'; END IF;

  DELETE FROM users WHERE id = 'c-u2';

  SELECT count(*) INTO after_n FROM applications WHERE user_id = 'c-u2';
  IF after_n <> 0 THEN
    RAISE EXCEPTION '  FAIL  deleting a user left % orphaned application(s) — ON DELETE CASCADE did not port', after_n;
  END IF;
  RAISE NOTICE '  PASS  deleting a user cascades to their applications (% removed)', before_n;
END $$;

-- ── CHECK constraints (the schema's enum layer) ──────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'CHECK constraints';
  PERFORM must_fail('an application status outside the allowed set',
    $q$UPDATE applications SET status = 'not-a-real-status' WHERE id = 'c-a1'$q$);
  PERFORM must_fail('a user role outside the allowed set',
    $q$UPDATE users SET role = 'wizard' WHERE id = 'c-u1'$q$);
  PERFORM must_fail('a grade outside the allowed set',
    $q$UPDATE users SET grade = '14' WHERE id = 'c-u1'$q$);
END $$;

-- ── Types actually became what phase 5 said they did ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  RAISE NOTICE 'column types';

  SELECT data_type INTO t FROM information_schema.columns
   WHERE table_name = 'users' AND column_name = 'created_at';
  IF t <> 'timestamp with time zone' THEN
    RAISE EXCEPTION '  FAIL  users.created_at is %, expected timestamptz', t;
  END IF;

  SELECT data_type INTO t FROM information_schema.columns
   WHERE table_name = 'users' AND column_name = 'tfa_enabled';
  IF t <> 'boolean' THEN
    RAISE EXCEPTION '  FAIL  users.tfa_enabled is %, expected boolean', t;
  END IF;

  SELECT data_type INTO t FROM information_schema.columns
   WHERE table_name = 'hours_ledger' AND column_name = 'delta';
  IF t <> 'double precision' THEN
    RAISE EXCEPTION '  FAIL  hours_ledger.delta is %, expected double precision '
      '(numeric would come back as a JS string and break every hours sum)', t;
  END IF;

  -- The five columns a too-narrow name heuristic first left as text. They hold
  -- instants and are compared against now(); as text they would keep comparing
  -- lexicographically, which is exactly the hazard the conversion removes.
  FOR t IN
    SELECT data_type FROM information_schema.columns
     WHERE (table_name, column_name) IN
       (('events','application_deadline'), ('slots','start_datetime'),
        ('slots','end_datetime'), ('users','suspended_until'))
  LOOP
    IF t <> 'timestamp with time zone' THEN
      RAISE EXCEPTION '  FAIL  a deadline/datetime column is %, expected timestamptz', t;
    END IF;
  END LOOP;

  -- And the one that must NOT be an instant. `date_of_birth` is a calendar date
  -- feeding the under-13 age gate; reading it as an instant would place it at
  -- midnight UTC and shift it across a day boundary by timezone.
  SELECT data_type INTO t FROM information_schema.columns
   WHERE table_name = 'users' AND column_name = 'date_of_birth';
  IF t <> 'text' THEN
    RAISE EXCEPTION '  FAIL  users.date_of_birth is %, expected text — it is a date, not an instant', t;
  END IF;

  RAISE NOTICE '  PASS  timestamptz, boolean, double precision and the date-only exception all as designed';
END $$;

DROP FUNCTION must_fail(text, text);

-- Verification only. Nothing is kept.
ROLLBACK;
