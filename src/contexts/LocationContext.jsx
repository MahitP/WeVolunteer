import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const LocationContext = createContext(null);

export function LocationProvider({ children }) {
  const [location, setLocation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  // Check if we already have permission or if we should ask
  useEffect(() => {
    const hasAsked = sessionStorage.getItem('wv_asked_location');
    if (!hasAsked) {
      setShowPrompt(true);
    } else {
      // If they granted it previously in this session, try to get it
      if (sessionStorage.getItem('wv_location_granted') === 'true') {
        requestLocation(true);
      }
    }
  }, []);

  const requestLocation = useCallback((silent = false) => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser.');
      return;
    }

    setLoading(true);
    setError(null);
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
        setLoading(false);
        setPermissionDenied(false);
        sessionStorage.setItem('wv_location_granted', 'true');
        sessionStorage.setItem('wv_asked_location', 'true');
        setShowPrompt(false);
      },
      (err) => {
        setLoading(false);
        if (err.code === err.PERMISSION_DENIED) {
          setPermissionDenied(true);
          if (!silent) setError('Location access was denied.');
        } else {
          if (!silent) setError(err.message || 'Failed to get location.');
        }
        sessionStorage.setItem('wv_asked_location', 'true');
        sessionStorage.setItem('wv_location_granted', 'false');
        setShowPrompt(false);
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000 // 5 minutes
      }
    );
  }, []);

  const dismissPrompt = useCallback(() => {
    sessionStorage.setItem('wv_asked_location', 'true');
    sessionStorage.setItem('wv_location_granted', 'false');
    setShowPrompt(false);
  }, []);

  const clearLocation = useCallback(() => {
    setLocation(null);
    setError(null);
    setPermissionDenied(false);
    sessionStorage.setItem('wv_location_granted', 'false');
  }, []);

  return (
    <LocationContext.Provider value={{
      location,
      loading,
      error,
      permissionDenied,
      showPrompt,
      requestLocation,
      dismissPrompt,
      clearLocation
    }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocationContext() {
  return useContext(LocationContext);
}
