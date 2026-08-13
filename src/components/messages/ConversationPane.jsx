import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, MoreVertical, Send, Flag, BellOff, Archive, Check, CheckCheck, MapPin, CalendarCheck, MessageSquare } from 'lucide-react';
import { api } from '../../utils/api';
import { subscribeSocket, unsubscribeSocket, emitTypingStart, emitTypingStop } from '../../services/socket';
import ReportModal from './ReportModal';

function formatMessageTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ', ' + 
         date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatShortTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatEventDate(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** 
 * Classify each message for visual grouping.
 * Messages from the same sender within 2 minutes are grouped together.
 * Returns 'group-start' | 'group-middle' | 'group-end' | 'group-single'.
 */
function getGroupClass(messages, idx) {
  const m = messages[idx];
  const prev = idx > 0 ? messages[idx - 1] : null;
  const next = idx < messages.length - 1 ? messages[idx + 1] : null;
  const TWO_MIN = 2 * 60 * 1000;

  const sameSenderAsPrev = prev && prev.senderId === m.senderId && (new Date(m.createdAt) - new Date(prev.createdAt)) < TWO_MIN;
  const sameSenderAsNext = next && next.senderId === m.senderId && (new Date(next.createdAt) - new Date(m.createdAt)) < TWO_MIN;

  if (sameSenderAsPrev && sameSenderAsNext) return 'group-middle';
  if (!sameSenderAsPrev && sameSenderAsNext) return 'group-start';
  if (sameSenderAsPrev && !sameSenderAsNext) return 'group-end';
  return 'group-start'; // single message treated as start (gets top padding)
}

export default function ConversationPane({ conversation, onBack, onUpdateConversation, emptyCopy }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [inputText, setInputText] = useState('');
  const [typingUsers, setTypingUsers] = useState(new Set());
  const [showMenu, setShowMenu] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [otherReadAt, setOtherReadAt] = useState(conversation?.otherParticipant?.lastReadAt || null);
  const [rateLimitError, setRateLimitError] = useState('');
  const [isOffline, setIsOffline] = useState(false);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  const other = conversation?.otherParticipant;

  const fetchConversationMessages = useCallback(() => {
    setLoading(true);
    api.fetchMessages(conversation.id)
      .then(res => {
        /**
         * No reverse. The server already returns oldest-first.
         *
         * `messageRoutes.js` selects `ORDER BY created_at DESC LIMIT ?` to take
         * the newest N and then calls `rows.reverse()`, so the response is
         * ascending — `messaging.friends.test.js` asserts exactly that. This
         * line reversed it a second time and rendered the thread newest-first.
         *
         * Every other write path in this component appends (`[...prev, msg]`
         * for both socket delivery and your own send), so history ran one way
         * and new messages the other. That disagreement is the tell.
         */
        setMessages(res.messages || []);
        setHasMore(res.hasMore);
        /* Jump, not glide: opening a thread should START at the newest message.
           Smooth-scrolling there means the first thing somebody sees is the top
           of a conversation they have already read, sliding away. */
        scrollToBottom({ smooth: false });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [conversation?.id]);

  useEffect(() => {
    if (!conversation) return;
    setOtherReadAt(conversation.otherParticipant?.lastReadAt || null);
    fetchConversationMessages();
  }, [conversation?.id, fetchConversationMessages]);

  useEffect(() => {
    const handleConnect = () => {
      setIsOffline(false);
      setTypingUsers(new Set());
      if (conversation?.id) fetchConversationMessages();
    };
    const handleDisconnect = () => setIsOffline(true);
    
    window.addEventListener('wev:socket_connect', handleConnect);
    window.addEventListener('wev:socket_disconnect', handleDisconnect);
    return () => {
      window.removeEventListener('wev:socket_connect', handleConnect);
      window.removeEventListener('wev:socket_disconnect', handleDisconnect);
    };
  }, [conversation?.id, fetchConversationMessages]);

  useEffect(() => {
    if (!conversation) return;

    const handleNewMessage = (payload) => {
      if (payload.conversationId === conversation.id) {
        setMessages(prev => {
          if (prev.find(m => m.id === payload.message.id)) return prev;
          return [...prev, payload.message];
        });
        scrollToBottom();
        api.markConversationRead(conversation.id, payload.message.id).catch(console.error);
      }
    };

    const handleTypingStart = (payload) => {
      if (payload.conversationId === conversation.id) {
        setTypingUsers(prev => {
          const next = new Set(prev);
          next.add(payload.userId);
          return next;
        });
      }
    };

    const handleTypingStop = (payload) => {
      if (payload.conversationId === conversation.id) {
        setTypingUsers(prev => {
          const next = new Set(prev);
          next.delete(payload.userId);
          return next;
        });
      }
    };

    const handleRead = (payload) => {
      if (payload.conversationId === conversation.id && payload.userId === other?.id) {
        setOtherReadAt(payload.lastReadAt);
      }
    };

    subscribeSocket('message.created', handleNewMessage);
    subscribeSocket('typing.start', handleTypingStart);
    subscribeSocket('typing.stop', handleTypingStop);
    subscribeSocket('conversation.read', handleRead);

    return () => {
      unsubscribeSocket('message.created', handleNewMessage);
      unsubscribeSocket('typing.start', handleTypingStart);
      unsubscribeSocket('typing.stop', handleTypingStop);
      unsubscribeSocket('conversation.read', handleRead);
    };
  }, [conversation?.id, other?.id]);

  /**
   * How close to the bottom still counts as "reading the newest".
   *
   * Roughly one short message plus its padding. Tighter and an ordinary
   * resting position registers as scrolled-away; looser and somebody a
   * paragraph up still gets yanked.
   */
  const NEAR_BOTTOM_PX = 120;

  const isNearBottom = () => {
    const list = messagesEndRef.current?.parentElement;
    if (!list) return true;
    return list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM_PX;
  };

  /**
   * Scrolls to the newest message.
   *
   * `force` is for your OWN send — you always want to see what you just wrote.
   * Everything else respects where the reader is: a message arriving while
   * somebody is deliberately reading back through a thread must not drag them
   * away from it, which is the difference between a chat that follows the
   * conversation and one that fights the person using it.
   *
   * `requestAnimationFrame` rather than `setTimeout(…, 100)`: the old version
   * was a race against React's commit that happened to usually win, and on a
   * slow render it scrolled before the new message existed.
   */
  const scrollToBottom = ({ smooth = true, force = false } = {}) => {
    if (!force && !isNearBottom()) return;
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'auto',
        block: 'end',
      });
    });
  };

  const handleInputChange = (e) => {
    setInputText(e.target.value);
    
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
    
    emitTypingStart(conversation.id);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      emitTypingStop(conversation.id);
    }, 2000);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    
    const body = inputText;
    setInputText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    emitTypingStop(conversation.id);
    
    try {
      const res = await api.sendMessage(conversation.id, body);
      setRateLimitError('');
      setMessages(prev => {
         if (prev.find(m => m.id === res.message.id)) return prev;
         return [...prev, res.message];
      });
      /* Forced: you always want to see the message you just sent, wherever you
         had scrolled to before sending it. */
      scrollToBottom({ force: true });
    } catch (err) {
      if (err.status === 429) {
        setRateLimitError("You're sending messages too quickly. Please wait a moment.");
        setInputText(body);
        setTimeout(() => setRateLimitError(''), 5000);
      } else {
        console.error(err);
      }
    }
  };

  const handleMenuAction = async (action) => {
    setShowMenu(false);
    if (action === 'report') {
      setShowReport(true);
    }
    if (action === 'mute') {
      const muted = !conversation.mutedUntil;
      await api.updateConversationPreferences(conversation.id, { muted });
      onUpdateConversation({ mutedUntil: muted ? 'forever' : null });
    }
    if (action === 'archive') {
      const archived = !conversation.archived;
      await api.updateConversationPreferences(conversation.id, { archived });
      onUpdateConversation({ archived });
    }
  };

  // Determine the last message sent by the current user for receipt display
  const myLastMessageIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].senderId !== other?.id) return i;
    }
    return -1;
  })();

  return (
    <div className="conversation-pane">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="pane-header">
        <button className="btn-icon mobile-only back-btn" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft size={20} />
        </button>
        <div className="pane-header-avatar">
          {other?.name?.charAt(0)?.toUpperCase() || 'U'}
        </div>
        <div className="pane-header-info">
          <h3 className="pane-title">
            {other?.name || 'Unknown'}
            {isOffline && (
              <span className="offline-pill">
                <span className="offline-dot" />
                Reconnecting
              </span>
            )}
          </h3>
          {other?.role && <div className="pane-role">{other.role}</div>}
          {conversation.event && (
            <div className="pane-subtitle">
              <CalendarCheck size={12} />
              {conversation.event.title}
            </div>
          )}
          {conversation.event && (
            <div className="pane-meta">
              {conversation.event.location && (
                <span><MapPin size={11} /> {conversation.event.location}</span>
              )}
              {conversation.event.startDatetime && (
                <span><CalendarCheck size={11} /> {formatEventDate(conversation.event.startDatetime)}</span>
              )}
            </div>
          )}
        </div>
        <div className="pane-actions">
          <button className="btn-icon" onClick={() => setShowMenu(!showMenu)} aria-label="Conversation actions">
            <MoreVertical size={20} />
          </button>
          {showMenu && (
            <>
              <div className="dropdown-overlay" onClick={() => setShowMenu(false)}></div>
              <div className="dropdown-menu" role="menu">
                <button onClick={() => handleMenuAction('mute')} role="menuitem">
                  <BellOff size={16} /> {conversation.mutedUntil ? 'Unmute' : 'Mute'}
                </button>
                <button onClick={() => handleMenuAction('archive')} role="menuitem">
                  <Archive size={16} /> {conversation.archived ? 'Unarchive' : 'Archive'}
                </button>
                <div className="dropdown-divider"></div>
                <button className="text-danger" onClick={() => handleMenuAction('report')} role="menuitem">
                  <Flag size={16} /> Report
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      
      {/* ── Messages area ───────────────────────────────────────────── */}
      <div className="messages-list">
        {loading && <div className="messages-loading">Loading messages...</div>}
        
        {!loading && messages.length === 0 && (
          <div className="chat-empty-state">
            <div className="empty-emoji">👋</div>
            {/* An administrator's thread is about a report, not about a shift, and
                the student's line ("stay connected with your volunteer
                opportunity") described the one kind of conversation an
                administrator never has. Falls back so the component still renders
                if a caller forgets to pass copy. */}
            <h4>{emptyCopy?.title || 'Start the conversation'}</h4>
            <p>{emptyCopy?.body || 'Coordinate details, ask questions, and stay connected.'}</p>
          </div>
        )}

        {!loading && messages.map((m, idx) => {
          const isMine = m.senderId !== other?.id;
          const showTime = idx === 0 || (new Date(m.createdAt) - new Date(messages[idx-1].createdAt) > 1000 * 60 * 60);
          const groupClass = getGroupClass(messages, idx);
          const isMyLastMessage = isMine && idx === myLastMessageIdx;
          const isRead = otherReadAt && new Date(m.createdAt) <= new Date(otherReadAt);

          return (
            <React.Fragment key={m.id}>
              {showTime && (
                <div className="message-time-divider">
                  <span>{formatMessageTime(m.createdAt)}</span>
                </div>
              )}
              <div className={`message-bubble-wrapper ${isMine ? 'mine' : 'theirs'} ${groupClass}`}>
                <div className="message-bubble">
                  {m.body}
                </div>
                {isMyLastMessage && (
                  <div className="message-meta">
                    {formatShortTime(m.createdAt)}
                    {' · '}
                    {isRead ? (
                      <><CheckCheck size={14} className="receipt-icon" /> Seen</>
                    ) : (
                      <><Check size={14} /> Sent</>
                    )}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        
        {typingUsers.size > 0 && (
          <div className="typing-indicator-wrapper">
            <span className="typing-label">{other?.name?.split(' ')[0] || 'Someone'} is typing</span>
            <div className="typing-indicator">
              <span className="dot"></span>
              <span className="dot"></span>
              <span className="dot"></span>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>
      
      {/* ── Composer ────────────────────────────────────────────────── */}
      {/**
        * ── `writable`, not `readOnly` — the latter is a field that does not exist ──
        *
        * `computeConversationLifecycle` returns `{ state, writable, reason,
        * readOnlyAt, banner }`. There is no `readOnly` key and there never has
        * been, so this test read `undefined` on every conversation and the
        * composer rendered unconditionally. A read-only thread — a completed
        * event, a withdrawn application, a block — showed a working message box
        * that answered 409 on submit, and the server's carefully written
        * `banner` explaining WHY was never displayed to anybody.
        *
        * Checked as `=== false` rather than `!writable` so that a conversation
        * whose lifecycle failed to load does not silently lock the composer:
        * absent means unknown, and the server is the authority either way.
        *
        * The banner is preferred over the generic sentence because it is the one
        * that says which rule closed the thread. That matters most for the peer
        * kind, where "read-only" with no reason reads as a fault rather than as
        * the consequence of a friendship ending.
        */}
      {conversation.lifecycle?.writable === false ? (
        <div className="composer-readonly">
          {conversation.lifecycle.banner || 'This conversation is read-only.'}
        </div>
      ) : (
        <div className="composer-area">
          {rateLimitError && (
            <div className="rate-limit-toast">{rateLimitError}</div>
          )}
          <form className="message-composer" onSubmit={handleSend}>
            <textarea 
              ref={textareaRef}
              rows={1}
              placeholder="Type a message..."
              value={inputText}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              className="composer-input"
              aria-label="Message input"
            />
            <button type="submit" className="composer-send" disabled={!inputText.trim()} aria-label="Send message">
              <Send size={18} />
            </button>
          </form>
        </div>
      )}
      
      {showReport && (
        <ReportModal 
          conversationId={conversation.id} 
          onClose={() => setShowReport(false)} 
        />
      )}
    </div>
  );
}
