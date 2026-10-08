import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AdminPortal from './admin/AdminPortal';
import './styles.css';

const RootApp = window.location.pathname.startsWith('/admin') ? AdminPortal : App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>
);
