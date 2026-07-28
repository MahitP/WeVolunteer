import React, { useEffect, useState } from 'react';
import { Megaphone, Pencil, Trash2, Check, X } from 'lucide-react';
import { api } from '../utils/api';
import { timeAgo } from '../utils/helpers';

/**
 * Organizer-to-volunteer updates for a single event.
 *
 * Deliberately one-way: no replies, no direct messages. Questions belong in
 * the event discussion, which keeps announcements scannable as the record of
 * "what changed since I signed up".
 */
export default function EventAnnouncements({ eventId, canPost, addToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState('');

  const load = async () => {
    try {
      setItems(await api.fetchAnnouncements(eventId));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (eventId) load(); }, [eventId]);

  const post = async (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      const created = await api.postAnnouncement(eventId, body);
      setDraft('');
      addToast(
        created.notified > 0
          ? `Update posted. ${created.notified} volunteer${created.notified !== 1 ? 's' : ''} notified.`
          : 'Update posted.',
        'success'
      );
      load();
    } catch (err) {
      addToast(`Could not post update: ${err.message}`, 'error');
    } finally {
      setPosting(false);
    }
  };

  const saveEdit = async (id) => {
    const body = editBody.trim();
    if (!body) return;
    try {
      await api.updateAnnouncement(id, body);
      setEditingId(null);
      addToast('Update edited.', 'success');
      load();
    } catch (err) {
      addToast(`Could not save: ${err.message}`, 'error');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this update? Volunteers will no longer see it.')) return;
    try {
      await api.deleteAnnouncement(id);
      addToast('Update deleted.', 'info');
      load();
    } catch (err) {
      addToast(`Could not delete: ${err.message}`, 'error');
    }
  };

  if (loading) {
    return <div className="skeleton skeleton-row" />;
  }

  return (
    <div className="stack">
      {canPost && (
        <form onSubmit={post} className="inset">
          <label htmlFor="ann-draft" className="label" style={{ display: 'block', marginBottom: 6 }}>
            Post an update
          </label>
          <textarea
            id="ann-draft"
            className="textarea"
            style={{ minHeight: 72, background: 'var(--surface)' }}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            maxLength={2000}
            disabled={posting}
            placeholder="Meet at the south lot, not the main entrance. Bring gloves if you have them."
          />
          <div className="row-between" style={{ marginTop: 'var(--s2)' }}>
            <span className="small dim">Everyone confirmed for this event gets a notification.</span>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!draft.trim() || posting}>
              <Megaphone size={13} /> {posting ? 'Posting…' : 'Post update'}
            </button>
          </div>
        </form>
      )}

      {items.length === 0 ? (
        <div className="empty" style={{ padding: 'var(--s6) var(--s4)' }}>
          <span className="empty-icon"><Megaphone size={18} /></span>
          <h3>No updates yet</h3>
          <p>
            {canPost
              ? 'Post here if anything changes — location, timing, or what to bring.'
              : 'If the organizer posts changes to this event, they\'ll appear here.'}
          </p>
        </div>
      ) : (
        <div className="stack-sm">
          {items.map(item => (
            <article key={item.id} className="card card-pad" style={{ background: 'var(--warn-tint)', borderColor: 'var(--warn-tint-2)' }}>
              <div className="row" style={{ gap: 'var(--s2)', marginBottom: 'var(--s2)' }}>
                <Megaphone size={14} style={{ color: 'var(--warn)' }} />
                <span className="small strong">{item.author.name}</span>
                <span className="tag tag-warn">Organizer</span>
                <span className="small dim">
                  {timeAgo(item.createdAt)}
                  {item.updatedAt && ' · edited'}
                </span>
                {canPost && editingId !== item.id && (
                  <span className="row" style={{ gap: 2, marginLeft: 'auto' }}>
                    <button
                      className="btn btn-ghost btn-sm btn-icon"
                      aria-label="Edit update"
                      onClick={() => { setEditingId(item.id); setEditBody(item.body); }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="btn btn-ghost btn-sm btn-icon"
                      style={{ color: 'var(--danger)' }}
                      aria-label="Delete update"
                      onClick={() => remove(item.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                )}
              </div>

              {editingId === item.id ? (
                <>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 72, background: 'var(--surface)' }}
                    value={editBody}
                    onChange={e => setEditBody(e.target.value)}
                    maxLength={2000}
                  />
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
                      <X size={13} /> Cancel
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => saveEdit(item.id)} disabled={!editBody.trim()}>
                      <Check size={13} /> Save
                    </button>
                  </div>
                </>
              ) : (
                <p className="comment-body" style={{ margin: 0 }}>{item.body}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
