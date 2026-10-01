import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { MessageSquare, Plus } from 'lucide-react';
import { api } from "../utils/api";
import { subscribeSocket, unsubscribeSocket } from '../services/socket';
import ConversationList from '../components/messages/ConversationList';
import ConversationPane from '../components/messages/ConversationPane';
import RecipientPicker from '../components/messages/RecipientPicker';
import { recipientCopyFor } from '../components/messages/recipientCopy';

export default function Messages() {
  /**
   * Every messaging surface's wording, from one capability cascade.
   *
   * Read from the cached user rather than threaded through props because the
   * recipient picker below already does exactly that — two ways of answering
   * "who is reading this" is how the picker and the empty states end up
   * disagreeing about it.
   */
  const copy = recipientCopyFor(api.getCurrentCachedUser());

  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isMobilePaneVisible, setIsMobilePaneVisible] = useState(false);
  const layoutRef = useRef(null);

  /**
   * On a phone, an open conversation runs from wherever it starts to the top of
   * the tab bar — measured, not assumed. What sits above it varies: the shell's
   * own padding, a notice banner, the demo bar in a demo build, a top bar whose
   * height follows its content. A fixed budget (`100dvh - 140px`) put the reply
   * box behind the tab bar at 850px on an 812px screen. So the page goes to the
   * top, the thread's actual start is read, and the stylesheet does the rest
   * with `--thread-top`. See src/messagesMobileThread.test.js.
   */
  useLayoutEffect(() => {
    const place = () => {
      const el = layoutRef.current;
      if (!el) return;
      el.style.setProperty('--thread-top', `${Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY))}px`);
    };
    /* Opening a conversation on a phone starts it at the top of the screen. */
    if (isMobilePaneVisible && window.matchMedia?.('(max-width: 700px)')?.matches) window.scrollTo(0, 0);
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [isMobilePaneVisible]);
  const [isOffline, setIsOffline] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    const loadConversations = async () => {
      try {
        setLoading(true);
        const data = await api.fetchConversations();
        setConversations(data?.conversations || []);
      } catch (err) {
        setError('Failed to load conversations.');
      } finally {
        setLoading(false);
      }
    };
    loadConversations();

    const handleConnect = () => {
      setIsOffline(false);
      loadConversations();
    };
    const handleDisconnect = () => setIsOffline(true);

    window.addEventListener('wev:socket_connect', handleConnect);
    window.addEventListener('wev:socket_disconnect', handleDisconnect);
    return () => {
      window.removeEventListener('wev:socket_connect', handleConnect);
      window.removeEventListener('wev:socket_disconnect', handleDisconnect);
    };
  }, []);

  useEffect(() => {
    const handleNewMessage = (payload) => {
      const { conversationId, message } = payload;
      setConversations(prev => {
        const exists = prev.find(c => c.id === conversationId);
        if (exists) {
          const updated = prev.map(c => 
            c.id === conversationId 
              ? { 
                  ...c, 
                  lastMessage: message, 
                  unreadCount: (activeConversationId !== conversationId) ? (c.unreadCount || 0) + 1 : 0 
                } 
              : c
          );
          return updated.sort((a, b) => new Date(b.lastMessage?.createdAt || 0) - new Date(a.lastMessage?.createdAt || 0));
        } else {
          api.fetchConversations().then(data => setConversations(data?.conversations || []));
          return prev;
        }
      });
    };

    subscribeSocket('message.created', handleNewMessage);
    return () => unsubscribeSocket('message.created', handleNewMessage);
  }, [activeConversationId]);

  const handleSelectConversation = (id) => {
    setActiveConversationId(id);
    setIsMobilePaneVisible(true);
    
    const convo = conversations.find(c => c.id === id);
    if (convo && convo.unreadCount > 0) {
      api.markConversationRead(id, convo.lastMessage?.id).catch(console.error);
      setConversations(prev => prev.map(c => c.id === id ? { ...c, unreadCount: 0 } : c));
    }
  };

  const handleBackToList = () => {
    setIsMobilePaneVisible(false);
    setActiveConversationId(null);
  };

  const activeConversation = conversations.find(c => c.id === activeConversationId);

  const handleSelectRecipient = async (recipient) => {
    try {
      setShowPicker(false);
      const currentUser = api.getCurrentCachedUser();

      /**
       * Which endpoint opens this thread is decided by what the row IS.
       *
       * `kind` comes from the search response rather than being inferred from
       * `eventId` being absent — the same reason `decorateConversation` returns a
       * stored `kind` instead of guessing from a null event. Both endpoints
       * re-authorise from scratch, so this choice is a routing decision and never
       * a permission one: sending a friend id to the event endpoint, or vice
       * versa, is refused by the server, not by this branch.
       */
      const res = recipient.kind === 'friend'
        ? await api.resolvePeerConversation(recipient.id)
        : await api.resolveConversation(
            recipient.eventId,
            currentUser.role === 'student' ? currentUser.id : recipient.id
          );

      setConversations(prev => {
        if (!prev.find(c => c.id === res.conversation.id)) {
          return [res.conversation, ...prev];
        }
        return prev;
      });
      setActiveConversationId(res.conversation.id);
      setIsMobilePaneVisible(true);
    } catch (err) {
      console.error(err);
      setError('Failed to start conversation.');
    }
  };

  return (
    /* `thread-open` lets the stylesheet give an open conversation the whole
       phone screen between the top bar and the tab bar; see
       src/messagesMobileThread.test.js. */
    <div className={`page messages-page${isMobilePaneVisible ? ' thread-open' : ''}`}>
      {showPicker && (
        <RecipientPicker
          user={api.getCurrentCachedUser()}
          onClose={() => setShowPicker(false)}
          onSelect={handleSelectRecipient}
        />
      )}
      {/* Styled by class, not inline: an inline `display` would outrank the
          phone rule that hides this row while a conversation is open. */}
      <div className="page-head messages-head">
        <h2 className="page-title">
          Messages
          {isOffline && (
            <span className="offline-pill" style={{ marginLeft: '0.75rem', verticalAlign: 'middle' }}>
              <span className="offline-dot" />
              Reconnecting
            </span>
          )}
        </h2>
        {/**
          * Words on a desktop, a glyph on a phone.
          *
          * This was a full `btn btn-primary` with an 18px icon carrying a
          * hardcoded 8px margin ON TOP of `.btn`'s own gap, so the icon spacing
          * was doubled. At 375px it came out about 150×44 sitting beside a
          * 1.5rem "Messages" heading on a row whose flex lives in an inline
          * style — which means no media query can reach it, the same class of
          * bug the dashboard comment describes.
          *
          * The label is hidden rather than dropped, so the accessible name is
          * unchanged at every width and a screen reader still hears "New
          * message". `title` gives sighted phone users the tooltip. `btn-icon`
          * is what carries the 44px WIDTH floor — without it an icon-only
          * button is a 44px-tall sliver, which index.css's own comment warns
          * about.
          */}
        <button
          className="btn btn-primary btn-icon-responsive"
          onClick={() => setShowPicker(true)}
          title="New message"
          aria-label="New message"
        >
          <Plus size={18} aria-hidden="true" />
          <span className="btn-label-wide">New Message</span>
        </button>
      </div>
      <div className="messages-layout" ref={layoutRef}>
        <div className={`messages-sidebar ${isMobilePaneVisible ? 'mobile-hidden' : ''}`}>
          <ConversationList 
            conversations={conversations} 
            activeId={activeConversationId} 
            onSelect={handleSelectConversation}
            loading={loading}
            error={error}
            emptyText={copy.listEmpty}
          />
        </div>
        <div className={`messages-main ${!isMobilePaneVisible ? 'mobile-hidden' : ''}`}>
          {activeConversation ? (
            <ConversationPane 
              conversation={activeConversation} 
              emptyCopy={copy.threadEmpty}
              onBack={handleBackToList}
              onUpdateConversation={(updates) => {
                setConversations(prev => prev.map(c => c.id === activeConversation.id ? { ...c, ...updates } : c));
              }}
            />
          ) : (
            /* Expression position, not children — a block comment here is a real
               comment. It only becomes visible text when it sits among an
               element's CHILDREN, which is the mistake AdminDashboard.jsx shipped
               and `setupTests.js` now fails the build on.

               Role-aware: an administrator's threads are moderation conversations,
               not "volunteer opportunity" ones, and an organizer read the
               student's sentence backwards. Same cascade as the recipient picker,
               so the two cannot disagree about who is reading. */
            <div className="messages-empty-state">
              <div className="empty-state-content">
                <MessageSquare size={48} className="empty-state-icon" />
                {/* `h2`, not `h3`: with no conversation open this is the only
                    heading under the page's `h1`, so `h3` skipped a level for
                    anybody navigating by heading — which is how a screen reader
                    user skims. The styling is unchanged; only the level moved. */}
                <h2>{copy.noneSelected.title}</h2>
                <p>{copy.noneSelected.body}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
