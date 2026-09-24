import '@clearedby/react/styles.css'
import './app.css'
import type { ReactNode } from 'react'

export const metadata = { title: 'Approvals · Example partner app' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
