import Sidebar from '@/components/app/Sidebar';
import EmailOptInToast from '@/components/app/EmailOptInToast';
import { ThemeProvider } from '@/lib/theme-context';
import styles from './layout.module.css';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider>
      <div className={styles.appLayout}>
        <Sidebar />
        <div className={styles.appMain}>
          {children}
        </div>
        <EmailOptInToast />
      </div>
    </ThemeProvider>
  );
}
