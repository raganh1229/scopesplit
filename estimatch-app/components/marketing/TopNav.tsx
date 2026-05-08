'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useUser, useClerk } from '@clerk/nextjs';
import styles from './TopNav.module.css';

export default function TopNav() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();

  const emailAddress = user?.primaryEmailAddress?.emailAddress || '';
  const emailLocalPart = emailAddress.split('@')[0]?.trim() || '';
  const fullName = user?.fullName || user?.firstName || emailLocalPart || 'User';
  const initials = fullName
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || (emailAddress[0]?.toUpperCase() ?? 'U');

  const navLinks = [
    { href: '/', label: 'Home' },
    { href: '/faq', label: 'FAQ' },
    { href: '/contact', label: 'Contact' },
  ];

  return (
    <>
      <nav className={styles.topnav}>
        <div className={styles.topnavInner}>
          <Link className={styles.topnavLogo} href="/">
            <Image
              src="/logo_black.png"
              alt="ScopeSplit"
              width={360}
              height={84}
              unoptimized
              className={styles.topnavLogoImg}
              priority
            />
          </Link>
          <div className={styles.topnavLinks}>
            {navLinks.map(link => (
              <Link
                key={link.href}
                className={`${styles.topnavLink} ${pathname === link.href ? styles.active : ''}`}
                href={link.href}
              >
                {link.label}
              </Link>
            ))}
            {isSignedIn ? (
              <div className={styles.userArea}>
                <button
                  className={styles.userAvatar}
                  onClick={() => setUserMenuOpen(v => !v)}
                  aria-label="Account menu"
                >
                  {initials}
                </button>
                {userMenuOpen && (
                  <div className={styles.userDropdown}>
                    <div className={styles.userDropdownName}>{fullName}</div>
                    <button
                      className={styles.userDropdownItem}
                      onClick={() => { setUserMenuOpen(false); signOut({ redirectUrl: '/' }); }}
                    >
                      <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                      Log out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <Link className={`${styles.topnavLink} ${pathname === '/login' ? styles.active : ''}`} href="/login">Log in</Link>
                <Link className={styles.topnavCta} href="/signup">Sign Up Free</Link>
              </>
            )}
          </div>
          <button className={styles.topnavHamburger} onClick={() => setDrawerOpen(true)}>
            <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          </button>
        </div>
      </nav>

      {/* Mobile drawer */}
      <div className={`${styles.mobileNavOverlay} ${drawerOpen ? styles.open : ''}`} onClick={() => setDrawerOpen(false)} />
      <div className={`${styles.mobileNavDrawer} ${drawerOpen ? styles.open : ''}`}>
        <button className={styles.mobileNavClose} onClick={() => setDrawerOpen(false)}>
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
        {navLinks.map(link => (
          <Link key={link.href} className={styles.mobileNavLink} href={link.href} onClick={() => setDrawerOpen(false)}>
            {link.label}
          </Link>
        ))}
        {isSignedIn ? (
          <button
            className={styles.mobileNavCta}
            style={{ background: 'none', color: 'var(--text-primary)', border: '0.5px solid var(--border-default)' }}
            onClick={() => { setDrawerOpen(false); signOut({ redirectUrl: '/' }); }}
          >
            Log out
          </button>
        ) : (
          <>
            <Link className={styles.mobileNavLink} href="/login" onClick={() => setDrawerOpen(false)}>Log in</Link>
            <Link className={styles.mobileNavCta} href="/signup" onClick={() => setDrawerOpen(false)}>Sign Up Free</Link>
          </>
        )}
      </div>
    </>
  );
}
