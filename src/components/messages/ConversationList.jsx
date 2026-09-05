import React, { useEffect, useState } from 'react';
import { Search, BellOff, MessageSquare } from 'lucide-react';
import { api } from '../../utils/api';

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

  /**
   * ── The same box now searches what was SAID, not only who said it ──
   *
   * `filtered` above is a client-side scan over already-loaded conversation
   * metadata: the other participant's name and the event title. That is a
   * useful thing and it is not what anybody types into a search box in a
   * messaging client. Somebody who remembers a phrase and types it matched
   * nothing — and `GET /api/messages/search`, which searches message BODIES
   * scoped to the caller's own threads, existed the whole time with no caller.
   * Its own code carries a fix for a join that dropped event-less threads,
   * whose comment predicted this exact outcome: a member would "reasonably
   * conclude the search was broken rather than that it had never looked."
   *
   * ONE box, two result groups. A second search field is the obvious
   * alternative and the wrong one: the reader does not know in advance whether
   * what they remember is a name or a sentence, which is the same argument that
   * folded `/directory` into Discover.
   *
   * Debounced AND aborted, for the two different reasons `BrowseEvents` records
   * for the directory search: the debounce stops one word being nine requests,
   * and the abort stops a slow answer for "tha" landing after a fast one for
   * "thanks" and replacing newer results with older ones.
   */
  const [messageHits, setMessageHits] = useState(null);
  const [searchingMessages, setSearchingMessages] = useState(false);

  useEffect(() => {
    const q = searchQuery.trim();
    /* Below two characters the server answers with an empty list rather than
       scanning, so there is no second rule about length here — just no request
       worth making. */
    if (q.length < 2) { setMessageHits(null); setSearchingMessages(false); return undefined; }

    const controller = new AbortController();
    setSearchingMessages(true);
    const timer = setTimeout(() => {
      api.searchMessages(q, { signal: controller.signal })
        .then(res => { setMessageHits(res.results || []); setSearchingMessages(false); })
        .catch(err => {
          if (err.name === 'AbortError') return;
          /* Silent, and the conversation matches above still render. The two
             searches fail independently and one of them working is still a
             useful list — the same posture BrowseEvents takes when the
             directory half fails. */
          setMessageHits([]);
          setSearchingMessages(false);
        });
    }, 250);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [searchQuery]);

  const searching = searchQuery.trim().length >= 2;
  const hasConversationHits = filtered.length > 0;
  const hasMessageHits = Boolean(messageHits && messageHits.length > 0);

  return (
    <div className="conversation-list-container">
      <div className="conversation-list-header">
        <div className="search-bar">
          <Search size={16} className="search-icon" />
          <input 
            type="text" 
            placeholder="Search conversations and messages" 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search conversations and messages"
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
              ? (searchingMessages
                /* "No matching conversations" while the message half is still
                   in flight would be answered again a moment later, which reads
                   as the list changing its mind. */
                ? 'Searching…'
                : hasMessageHits
                  ? 'No conversation names matched — see the messages below.'
                  : 'Nothing matched that.')
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

        {/**
          * ── Messages, as their OWN group ──
          *
          * Labelled and separated rather than mixed into the list above,
          * because the two answer different questions: a conversation match is
          * "this thread is with the person you named", and a message match is
          * "somebody said this in it". Merging them would make the count above
          * meaningless and would hide which of the two produced a row.
          *
          * The heading is only drawn when there is something under it, so a
          * search that matches only names does not show an empty section.
          */}
        {searching && hasMessageHits && (
          <>
            <div className="list-status eyebrow" id="message-hits-label">
              {hasConversationHits ? 'In messages' : 'Found in messages'}
            </div>
            <ul className="list-plain" aria-labelledby="message-hits-label">
              {messageHits.map(hit => (
                <li key={hit.message.id}>
                  <button
                    type="button"
                    className="conversation-item"
                    onClick={() => onSelect(hit.message.conversationId)}
                    aria-label={`Message from ${hit.senderName}: ${hit.snippet}`}
                  >
                    <div className="msg-avatar">
                      <MessageSquare size={16} aria-hidden="true" />
                    </div>
                    <div className="conversation-item-content">
                      <div className="conversation-item-top">
                        <span className="conversation-name truncate">{hit.senderName}</span>
                        <span className="conversation-time">
                          {formatRelativeTime(hit.message.createdAt)}
                        </span>
                      </div>
                      {/* `eventTitle` is null for a peer thread, which is
                          correct rather than missing data — the left join that
                          makes those rows appear at all is the endpoint's own
                          fix. */}
                      {hit.eventTitle && (
                        <span className="conversation-event truncate">{hit.eventTitle}</span>
                      )}
                      <div className="conversation-item-bottom">
                        <span className="conversation-preview truncate">{hit.snippet}</span>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* The message half is still in flight while the names have already
            been filtered locally, so its own progress has to be visible or a
            reader concludes there is nothing more to come. */}
        {searching && searchingMessages && hasConversationHits && (
          <div className="list-status" role="status">Searching messages…</div>
        )}
      </div>
    </div>
  );
}
