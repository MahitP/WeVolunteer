import React, { useState, useEffect } from 'react';
import { MessageSquare, Plus } from 'lucide-react';
import { api } from "../utils/api";
import { subscribeSocket, unsubscribeSocket } from '../services/socket';
import ConversationList from '../components/messages/ConversationList';
import ConversationPane from '../components/messages/ConversationPane';
import RecipientPicker from '../components/messages/RecipientPicker';

export default function Messages() {
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isMobilePaneVisible, setIsMobilePaneVisible] = useState(false);
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
      const studentId = currentUser.role === 'student' ? currentUser.id : recipient.id;
      const res = await api.resolveConversation(recipient.eventId, studentId);
      
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
    <div className="page" style={{ paddingTop: 'var(--s5)' }}>
      {showPicker && (
        <RecipientPicker
          user={api.getCurrentCachedUser()}
          onClose={() => setShowPicker(false)}
          onSelect={handleSelectRecipient}
        />
      )}
      <div className="page-head" style={{ marginBottom: 'var(--s2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>
          Messages
          {isOffline && (
            <span className="offline-pill" style={{ marginLeft: '0.75rem', verticalAlign: 'middle' }}>
              <span className="offline-dot" />
              Reconnecting
            </span>
          )}
        </h1>
        <button className="btn btn-primary" onClick={() => setShowPicker(true)}>
          <Plus size={18} style={{ marginRight: '8px' }} /> New Message
        </button>
      </div>
      <div className="messages-layout">
        <div className={`messages-sidebar ${isMobilePaneVisible ? 'mobile-hidden' : ''}`}>
          <ConversationList 
            conversations={conversations} 
            activeId={activeConversationId} 
            onSelect={handleSelectConversation}
            loading={loading}
            error={error}
          />
        </div>
        <div className={`messages-main ${!isMobilePaneVisible ? 'mobile-hidden' : ''}`}>
          {activeConversation ? (
            <ConversationPane 
              conversation={activeConversation} 
              onBack={handleBackToList}
              onUpdateConversation={(updates) => {
                setConversations(prev => prev.map(c => c.id === activeConversation.id ? { ...c, ...updates } : c));
              }}
            />
          ) : (
            <div className="messages-empty-state">
              <div className="empty-state-content">
                <MessageSquare size={48} className="empty-state-icon" />
                <h3>Select a conversation</h3>
                <p>Choose a volunteer opportunity conversation to start messaging.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
