'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useUser, useClerk } from '@clerk/nextjs';
import styles from './Sidebar.module.css';

const navItems = [
  { href: '/app/new-comparison', label: 'New Comparison', icon: <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg> },
  { href: '/app/comparisons', label: 'Comparisons', icon: <svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" /></svg> },
];

const bottomItems = [
  { href: '/app/settings', label: 'Settings', icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg> },
  { href: '/app/help', label: 'Contact Us', icon: <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg> },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { user } = useUser();
  const { signOut } = useClerk();

  const email = user?.primaryEmailAddress?.emailAddress || '';
  const emailLocalPart = email.split('@')[0]?.trim() || '';
  const fullName = user?.fullName || user?.firstName || emailLocalPart || 'User';
  const initials = fullName
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || (email[0]?.toUpperCase() ?? 'U');

  const handleLogout = async () => {
    setMenuOpen(false);
    try {
      await signOut({ redirectUrl: '/' });
    } catch {
      router.replace('/');
    }
  };

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleCloseMenu = () => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setMenuOpen(false);
      closeTimerRef.current = null;
    }, 1000);
  };

  useEffect(() => {
    return () => {
      clearCloseTimer();
    };
  }, []);

  return (
    <nav className={styles.sidebar}>
      <div className={styles.brand}>
        <Image src="/icon_logo_white.png" alt="ScopeSplit icon" width={56} height={56} className={styles.brandIcon} priority />
        <Image src="/text_logo_white.png" alt="ScopeSplit" width={320} height={84} className={styles.brandText} priority />
      </div>

      <div className={styles.nav}>
        {navItems.map(item => (
          <Link key={item.href} className={`${styles.item} ${pathname.startsWith(item.href) ? styles.active : ''}`} href={item.href}>
            <span className={styles.itemIcon}>{item.icon}</span>
            <span className={styles.itemLabel}>{item.label}</span>
          </Link>
        ))}
        <div className={styles.divider} />
        {bottomItems.map(item => (
          <Link key={item.label} className={`${styles.item} ${pathname.startsWith(item.href) ? styles.active : ''}`} href={item.href}>
            <span className={styles.itemIcon}>{item.icon}</span>
            <span className={styles.itemLabel}>{item.label}</span>
          </Link>
        ))}
      </div>

      <div className={styles.user} onMouseEnter={clearCloseTimer} onMouseLeave={scheduleCloseMenu}>
        <button type="button" className={styles.userBtn} onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}>
          <div className={styles.avatar}>{initials}</div>
          <span className={styles.userName}>{fullName}</span>
        </button>
        {menuOpen && (
          <div className={styles.userMenu} onClick={(e) => e.stopPropagation()}>
            <div className={styles.userEmail}>{email}</div>
            <button className={styles.userMenuItem} type="button" onClick={handleLogout}>
              <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
              Log out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
