import React, { useEffect, useState } from 'react';
import { MessageSquare, Send, Trash2, Loader2 } from 'lucide-react';
import { api } from '../utils/api';
import { timeAgo } from '../utils/helpers';

export default function EventComments({ eventId, currentUser, addToast }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);

  const load = async () => {
    try {
      setComments(await api.fetchComments(eventId));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (eventId) load(); }, [eventId]);

  const handlePost = async (e) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setPosting(true);
    try {
      await api.postComment(eventId, text);
      setBody('');
      load();
    } catch (err) {
      addToast(`Could not post: ${err.message}`, 'error');
    } finally {
      setPosting(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await api.deleteComment(id);
      load();
    } catch (err) {
      addToast(`Could not delete: ${err.message}`, 'error');
    }
  };

  return (
    <div>
      <div className="section-head">
        <h3 className="row" style={{ gap: 6 }}>
          <MessageSquare size={14} /> Questions and updates
          {comments.length > 0 && <span className="dim">({comments.length})</span>}
        </h3>
      </div>

      {loading ? (
        <div className="stack-sm">
          <div className="skeleton skeleton-line" style={{ width: '60%' }} />
          <div className="skeleton skeleton-line" style={{ width: '85%' }} />
        </div>
      ) : comments.length === 0 ? (
        <p className="small dim" style={{ marginBottom: 'var(--s4)' }}>
          No questions yet. Ask about parking, what to wear, or anything else.
        </p>
      ) : (
        <div style={{ marginBottom: 'var(--s4)' }}>
          {comments.map(c => {
            const canDelete = c.userId === currentUser?.id || currentUser?.role === 'admin';
            return (
              <div key={c.id} className="comment">
                <span className="avatar sm">{c.author.avatar || '👤'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="comment-name">{c.author.name}</span>
                    {c.author.role === 'organizer' && <span className="tag tag-brand">Host</span>}
                    {c.author.role === 'admin' && <span className="tag tag-warn">Staff</span>}
                    <span className="comment-time">{timeAgo(c.createdAt)}</span>
                    {canDelete && (
                      <button
                        className="btn btn-ghost btn-sm btn-icon"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => handleDelete(c.id)}
                        aria-label="Delete comment"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  <p className="comment-body">{c.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <form onSubmit={handlePost} className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
        <span className="avatar sm">{currentUser?.avatar || '👤'}</span>
        <div style={{ flex: 1 }}>
          <textarea
            className="textarea"
            style={{ minHeight: 62 }}
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Ask a question or share an update…"
            maxLength={1000}
            disabled={posting}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handlePost(e);
            }}
          />
          <div className="row-between" style={{ marginTop: 6 }}>
            <span className="small dim">⌘ + Enter to post</span>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!body.trim() || posting}>
              {posting ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
              {posting ? 'Posting…' : 'Post'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
