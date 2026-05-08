import TopNav from '@/components/marketing/TopNav';
import styles from './AuthShell.module.css';

export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopNav />
      <div className={styles.wrapper}>
        {children}
      </div>
    </>
  );
}
