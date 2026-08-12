import React, { useEffect, useState } from 'react';
import { Megaphone, MessageSquare, Trash2, Lock, Unlock } from 'lucide-react';
import { api } from '../utils/api';
import EmptyState from './common/EmptyState';

/**
 * What an organization tells its members, and what they say back.
 *
 * ── Replies, and the toggle ──
 *
 * Replies are on unless a manager turns them off, because an announcement
 * nobody can answer is a broadcast — and a volunteer noticing "that clashes
 * with the game" is most of the reason a club posts anything.
 *
 * When a manager turns them off, the replies already written STAY VISIBLE and
 * new ones stop. The control says "Replies open"/"Replies closed" rather than
 * "Allow replies", because the second reads like a permission being granted
 * when what is actually happening is a thread being locked — and a locked
 * thread is a thing everybody already understands, including that what was said
 * in it is still there.
 *
 * ── Who sees what ──
 *
 * Everyone who can read the organization reads the announcements; only a
 * manager gets the composer and the per-post controls. That is decided by the
 * server on every request — this component hiding a button is a convenience,
 * never the check.
 */
export default function OrganizationAnnouncements({ orgKey, canManage, isMember, addToast }) {
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [allowReplies, setAllowReplies] = useState(true);
  const [busy, setBusy] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.fetchOrganizationAnnouncements(orgKey)
      .then(res => { if (!cancelled) setAnnouncements(res?.announcements ?? []); })
      .catch(() => { if (!cancelled) setAnnouncements([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orgKey]);

  const publish = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const res = await api.postOrganizationAnnouncement(orgKey, {
        body: draft.trim(),
        repliesEnabled: allowReplies,
      });
      setAnnouncements(list => [res.announcement, ...list]);
      setDraft('');
      addToast?.('Announcement posted.', 'success');
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleReplies = async (a) => {
    setBusy(true);
    try {
      const res = await api.updateOrganizationAnnouncement(orgKey, a.id, { repliesEnabled: !a.repliesEnabled });
      /* The replies already on screen are carried across deliberately: the
         server keeps them and the PATCH response does not resend them. */
      setAnnouncements(list => list.map(x => (
        x.id === a.id ? { ...res.announcement, replies: x.replies } : x
      )));
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
              <label className="check">
                <input
                  type="checkbox"
                  checked={allowReplies}
                  onChange={e => setAllowReplies(e.target.checked)}
                />
                <span>Allow replies</span>
              </label>
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !draft.trim()}>
                <Megaphone size={14} aria-hidden="true" /> Post
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="muted">Loading announcements…</p>
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
                      {/* Says what the state IS, not what pressing it grants:
                          "Replies closed" is a thread that is locked, which
                          everybody already understands — including that what
                          was said in it is still there. */}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon"
                        disabled={busy}
                        onClick={() => toggleReplies(a)}
                        title={a.repliesEnabled ? 'Replies open — close them' : 'Replies closed — open them'}
                        aria-label={a.repliesEnabled ? 'Close replies on this announcement' : 'Open replies on this announcement'}
                      >
                        {a.repliesEnabled
                          ? <Unlock size={14} aria-hidden="true" />
                          : <Lock size={14} aria-hidden="true" />}
                      </button>
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

                {a.repliesEnabled ? (
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
                    <Lock size={12} aria-hidden="true" /> Replies are closed on this announcement.
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
