import { ReactNode, useState } from 'react';

export type AdminMenuItem={key:string;label:string;href:string};

export default function AdminLayout({userName,role,stores,selectedStore,onStoreChange,items,active,unread,onLogout,children}:{userName:string;role:string;stores:Array<{id:number;name:string}>;selectedStore:string;onStoreChange:(id:string)=>void;items:AdminMenuItem[];active:string;unread:number;onLogout:()=>void;children:ReactNode}){
  const[open,setOpen]=useState(false),[notificationsOpen,setNotificationsOpen]=useState(false);
  return <div className="admin-shell">
    <aside className={`admin-sidebar ${open?'is-open':''}`}>
      <div className="admin-brand"><span className="admin-brand-mark">S</span><div><b>Supermarket</b><small>Управление</small></div></div>
      <nav>{items.map(item=><a key={item.key} href={item.href} className={active===item.key?'active':''} onClick={()=>setOpen(false)}>{item.label}</a>)}</nav>
    </aside>
    {open?<button className="admin-menu-backdrop" aria-label="Закрыть меню" onClick={()=>setOpen(false)}/>:null}
    <div className="admin-workspace">
      <header className="admin-topbar">
        <button className="admin-menu-button" onClick={()=>setOpen(v=>!v)} aria-label="Открыть меню">☰</button>
        <div className="admin-topbar-title">Админ-панель</div>
        <div className="admin-topbar-actions">
          <select aria-label="Выбранный магазин" value={selectedStore} onChange={e=>onStoreChange(e.target.value)}>{role==='owner'?<option value="all">Все магазины</option>:null}{stores.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <button className="admin-icon-button" onClick={()=>setNotificationsOpen(v=>!v)} aria-label="Уведомления">🔔{unread>0?<span>{unread>99?'99+':unread}</span>:null}</button>
          <span className="admin-user-name">{userName} · {role==='owner'?'Владелец':'Администратор'}</span><button className="secondary" onClick={onLogout}>Выйти</button>
        </div>
        {notificationsOpen?<div className="admin-popover"><b>Уведомления</b><p>{unread?`Непрочитанных: ${unread}`:'Новых уведомлений нет'}</p></div>:null}
      </header>
      <main className="admin-content">{children}</main>
    </div>
  </div>;
}
