import React, { useEffect, useState } from 'react';
import { Megaphone, MessageSquare, Trash2, Lock } from 'lucide-react';
import { api } from '../utils/api';
import EmptyState from './common/EmptyState';

/**
 * What an organization tells its members, and what they say back.
 *
 * ── Replies ──
 *
 * Whether members may reply is an ORGANIZATION setting, edited in Manage
 * Organization, and it governs every announcement the organization publishes.
 * There is no per-post override: a manager deciding "we do not take replies" is
 * describing how their club communicates, not annotating one notice.
 *
 * Turning it off keeps the replies already written and stops new ones. Somebody
 * wrote those and other people read them; a settings toggle is not a moderation
 * decision, and hiding them would be worse still, because the authors would
 * carry on believing they had been heard.
 *
 * ── Who sees what ──
 *
 * Everyone who can read the organization reads the announcements; only a
 * manager gets the composer and the per-post controls. That is decided by the
 * server on every request — this component hiding a button is a convenience,
 * never the check.
 */
export default function OrganizationAnnouncements({ orgKey, canManage, isMember, repliesEnabled, addToast }) {
  const [announcements, setAnnouncements] = useState([]);
  /* Distinct from "loaded and empty". The card states "Nothing announced
     yet", which is a claim about what the organization has posted, and a
     failed request is not evidence for it. The list starts as [] rather than
     null here, so leaving it alone on failure would still render the claim —
     this flag is what separates the two. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.fetchOrganizationAnnouncements(orgKey)
      .then(res => { if (!cancelled) { setAnnouncements(res?.announcements ?? []); setLoadFailed(false); } })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        addToast?.('Could not load announcements. Reload to try again.', 'error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orgKey, addToast]);

  const publish = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const res = await api.postOrganizationAnnouncement(orgKey, { body: draft.trim() });
      setAnnouncements(list => [res.announcement, ...list]);
      setDraft('');
      addToast?.('Announcement posted.', 'success');
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a) => {
    if (!window.confirm('Delete this announcement? Replies to it are deleted too.')) return;
    setBusy(true);
    try {
      await api.deleteOrganizationAnnouncement(orgKey, a.id);
      setAnnouncements(list => list.filter(x => x.id !== a.id));
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async (a, e) => {
    e.preventDefault();
    const body = (replyDrafts[a.id] || '').trim();
    if (!body) return;
    setBusy(true);
    try {
      const res = await api.replyToOrganizationAnnouncement(orgKey, a.id, body);
      setAnnouncements(list => list.map(x => (
        x.id === a.id ? { ...x, replies: [...x.replies, res.reply] } : x
      )));
      setReplyDrafts(d => ({ ...d, [a.id]: '' }));
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head"><h2>Announcements</h2></div>
      <div className="card-body stack-md">
        {canManage && (
          <form className="stack-sm" onSubmit={publish}>
            <label className="field">
              <span className="sr-only">Write an announcement</span>
              <textarea
                className="input"
                rows={3}
                maxLength={4000}
                placeholder="Tell your members something…"
                value={draft}
                onChange={e => setDraft(e.target.value)}
              />
            </label>
            <div className="row-between">
              {/* Whether members can reply is an ORGANIZATION setting, in
                  Manage Organization — one answer for every announcement, no
                  per-post override. Said here so a manager is not left looking
                  for a control that used to be in this row. */}
              <span className="small dim">
                {repliesEnabled
                  ? 'Members can reply to announcements.'
                  : 'Replies are turned off for this organization.'}
              </span>
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !draft.trim()}>
                <Megaphone size={14} aria-hidden="true" /> Post
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="muted">Loading announcements…</p>
        ) : loadFailed ? (
          <p className="muted">Announcements could not be loaded. Reload to try again.</p>
        ) : announcements.length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="Nothing announced yet"
            message={canManage
              ? 'Post an update and every member will see it here.'
              : 'When this organization posts an update, it will appear here.'}
          />
        ) : (
          <ul className="stack-md org-announcements">
            {announcements.map(a => (
              <li key={a.id} className="org-announcement">
                <div className="row-between org-announcement-head">
                  <span className="small dim">
                    <strong>{a.author.name}</strong>
                    {' · '}
                    <time dateTime={a.createdAt}>{new Date(a.createdAt).toLocaleDateString()}</time>
                    {a.updatedAt && ' · edited'}
                  </span>
                  {canManage && (
                    <span className="row" style={{ gap: 'var(--s2)' }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon"
                        disabled={busy}
                        onClick={() => remove(a)}
                        title="Delete announcement"
                        aria-label={`Delete the announcement posted by ${a.author.name}`}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </span>
                  )}
                </div>

                <p className="org-announcement-body">{a.body}</p>

                {a.replies.length > 0 && (
                  <ul className="stack-sm org-replies">
                    {a.replies.map(r => (
                      <li key={r.id} className="org-reply">
                        <span className="small dim">
                          <strong>{r.author.name}</strong>
                          {' · '}
                          <time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleDateString()}</time>
                        </span>
                        <p>{r.body}</p>
                      </li>
                    ))}
                  </ul>
                )}

                {repliesEnabled ? (
                  isMember && (
                    <form className="row org-reply-form" onSubmit={e => sendReply(a, e)}>
                      <label className="field" style={{ flex: 1 }}>
                        <span className="sr-only">Reply to {a.author.name}</span>
                        <input
                          className="input"
                          maxLength={1000}
                          placeholder="Reply…"
                          value={replyDrafts[a.id] || ''}
                          onChange={e => setReplyDrafts(d => ({ ...d, [a.id]: e.target.value }))}
                        />
                      </label>
                      <button className="btn btn-secondary btn-sm" type="submit" disabled={busy || !(replyDrafts[a.id] || '').trim()}>
                        <MessageSquare size={14} aria-hidden="true" /> Reply
                      </button>
                    </form>
                  )
                ) : (
                  /* Said plainly, next to the replies that are still there, so
                     nobody wonders whether theirs was removed. */
                  <p className="small dim org-replies-closed">
                    <Lock size={12} aria-hidden="true" /> This organization has turned off replies.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
