import React, { useEffect, useState } from 'react';
import { MessageSquare, Send, Trash2, Loader2, Flag } from 'lucide-react';
import { api } from '../utils/api';
import { timeAgo } from '../utils/helpers';
import ReportModal from './ReportModal';

export default function EventComments({ eventId, currentUser, addToast }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [reportTarget, setReportTarget] = useState(null);

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
      await load();
    } catch (e) {
      console.error(e);
      addToast('Failed to post comment', 'error');
    } finally {
      setPosting(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await api.deleteComment(id);
      setComments(c => c.filter(x => x.id !== id));
    } catch (e) {
      console.error(e);
      addToast('Failed to delete comment', 'error');
    }
  };

  return (
    <div className="inset">
      <h3 className="row" style={{ alignItems: 'center', gap: 'var(--s2)', fontSize: '1rem', marginBottom: 'var(--s4)' }}>
        <MessageSquare size={18} />
        Questions &amp; Discussion
      </h3>

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
            const canReport = currentUser && c.userId !== currentUser.id;
            return (
              <div key={c.id} className="comment">
                <span className="avatar sm">{c.author.avatar || '👤'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="comment-name">{c.author.name}</span>
                    {c.author.role === 'organizer' && <span className="tag tag-brand">Host</span>}
                    {c.author.role === 'admin' && <span className="tag tag-warn">Staff</span>}
                    <span className="comment-time">{timeAgo(c.createdAt)}</span>
                    <div className="row" style={{ marginLeft: 'auto', gap: 4 }}>
                      {canReport && (
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => setReportTarget(c.id)}
                          aria-label="Report comment"
                          style={{ color: 'var(--error)' }}
                        >
                          <Flag size={12} />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => handleDelete(c.id)}
                          aria-label="Delete comment"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="comment-body">{c.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <form onSubmit={handlePost} className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
        <div style={{ flex: 1 }}>
          <textarea
            className="textarea"
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

      {reportTarget && (
        <ReportModal
          targetType="comment"
          targetId={reportTarget}
          onClose={() => setReportTarget(null)}
          addToast={addToast}
        />
      )}
    </div>
  );
}
