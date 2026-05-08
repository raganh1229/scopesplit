'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import styles from './MobileAppBar.module.css';

const navItems = [
  { href: '/app/new-comparison', label: 'New Comparison', icon: <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg> },
  { href: '/app/comparisons', label: 'Comparisons', icon: <svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" /></svg> },
  { href: '/app/settings', label: 'Settings', icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg> },
  { href: '/app/help', label: 'Get Help', icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg> },
];

interface MobileAppBarProps {
  title: string;
}

export default function MobileAppBar({ title }: MobileAppBarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className={styles.topbar}>
        <div className={styles.topbarLeft}>
          <button className={styles.hamburger} onClick={() => setOpen(true)}>
            <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          </button>
          <span className={styles.topbarTitle}>{title}</span>
        </div>
      </div>

      <div className={`${styles.overlay} ${open ? styles.open : ''}`} onClick={() => setOpen(false)} />
      <div className={`${styles.drawer} ${open ? styles.open : ''}`}>
        <div className={styles.drawerHeader}>
          <Image src="/text_logo_white.png" alt="ScopeSplit" width={360} height={84} className={styles.drawerLogoImg} priority />
        </div>
        <div className={styles.drawerNav}>
          {navItems.slice(0, 2).map(item => (
            <Link key={item.label} className={`${styles.drawerItem} ${pathname.startsWith(item.href) ? styles.active : ''}`} href={item.href} onClick={() => setOpen(false)}>
              {item.icon}{item.label}
            </Link>
          ))}
          <div className={styles.drawerDivider} />
          {navItems.slice(2).map(item => (
            <Link key={item.label} className={`${styles.drawerItem} ${pathname.startsWith(item.href) ? styles.active : ''}`} href={item.href} onClick={() => setOpen(false)}>
              {item.icon}{item.label}
            </Link>
          ))}
        </div>
        <div className={styles.drawerUser}>
          <div className={styles.drawerAvatar}>RH</div>
          <div className={styles.drawerUserInfo}>
            <div className={styles.drawerUserName}>Ragan Harrison</div>
            <div className={styles.drawerUserEmail}>rharrison@example.com</div>
          </div>
          <button className={styles.drawerLogout}>
            <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
          </button>
        </div>
      </div>
    </>
  );
}
