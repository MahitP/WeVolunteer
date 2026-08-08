import React, { useState } from 'react';
import { Search, BellOff } from 'lucide-react';

function formatRelativeTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ConversationList({ conversations, activeId, onSelect, loading, error, emptyText }) {
  const [searchQuery, setSearchQuery] = useState('');

  const filtered = conversations.filter(c => {
    const term = searchQuery.toLowerCase();
    const name = c.otherParticipant?.name || '';
    const eventTitle = c.event?.title || '';
    return name.toLowerCase().includes(term) || eventTitle.toLowerCase().includes(term);
  });

  return (
    <div className="conversation-list-container">
      <div className="conversation-list-header">
        <div className="search-bar">
          <Search size={16} className="search-icon" />
          <input 
            type="text" 
            placeholder="Search conversations..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search conversations"
          />
        </div>
      </div>
      
      <div className="conversation-list">
        {loading && <div className="list-status">Loading conversations...</div>}
        {error && <div className="list-status error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="list-status">
            {/* The search miss is the same for everybody — they typed something and
                it did not match. The empty INBOX is not: what would put a
                conversation here differs per role, and that is the sentence worth
                saying. Falls back if no copy was passed, so this component keeps
                working standalone. */}
            {searchQuery
              ? 'No matching conversations.'
              : (emptyText || 'No conversations yet.')}
          </div>
        )}
        
        {!loading && filtered.map(c => (
          <button 
            key={c.id} 
            className={`conversation-item ${activeId === c.id ? 'active' : ''} ${c.unreadCount > 0 ? 'unread' : ''}`}
            onClick={() => onSelect(c.id)}
            aria-label={`Conversation with ${c.otherParticipant?.name || 'Unknown'}`}
            aria-current={activeId === c.id ? 'true' : undefined}
          >
            <div className="msg-avatar">
              {c.otherParticipant?.name?.charAt(0)?.toUpperCase() || 'U'}
            </div>
            <div className="conversation-item-content">
              <div className="conversation-item-top">
                <span className="conversation-name truncate">
                  {c.otherParticipant?.name || 'Unknown'}
                </span>
                <span className="conversation-time">
                  {formatRelativeTime(c.lastMessage?.createdAt)}
                </span>
              </div>
              {c.event && (
                <span className="conversation-event truncate">{c.event.title}</span>
              )}
              <div className="conversation-item-bottom">
                <span className="conversation-preview truncate">
                  {c.lastMessage?.body || 'No messages yet.'}
                </span>
                {c.unreadCount > 0 && (
                  <span className="unread-badge">{c.unreadCount}</span>
                )}
                {c.mutedUntil && <BellOff size={13} className="dim" />}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
