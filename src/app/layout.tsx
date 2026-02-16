import './globals.css';

export const metadata = {
  title: 'Scene Viewer',
  description: '3D Scene with Shrimp NPCs',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
