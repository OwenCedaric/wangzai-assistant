import React from 'react';

const DesktopAuthContext = React.createContext({
  session: null,
  logout: async () => undefined,
});

export function DesktopAuthProvider({ value, children }) {
  return <DesktopAuthContext.Provider value={value}>{children}</DesktopAuthContext.Provider>;
}

export function useDesktopAuth() {
  return React.useContext(DesktopAuthContext);
}
