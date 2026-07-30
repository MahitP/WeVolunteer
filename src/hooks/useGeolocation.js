import { useState, useCallback } from 'react';

/**
 * Hook to manage browser geolocation permission and state.
 * Privacy: Coordinates are kept strictly in React component state and discarded on reload.
 */
export function useGeolocation() {
  const [location, setLocation] = useState(null); // { latitude, longitude }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const requestLocation = useCallback(() => {
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
      },
      (err) => {
        setLoading(false);
        if (err.code === err.PERMISSION_DENIED) {
          setPermissionDenied(true);
          setError('Location access was denied.');
        } else {
          setError(err.message || 'Failed to get location.');
        }
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000 // 5 minutes
      }
    );
  }, []);

  const clearLocation = useCallback(() => {
    setLocation(null);
    setError(null);
    setPermissionDenied(false);
  }, []);

  return {
    location,
    loading,
    error,
    permissionDenied,
    requestLocation,
    clearLocation
  };
}
