import { cookies } from 'next/headers'
import { DEMO_SUBJECTS } from '../lib/session'
import { Approvals } from './approvals'

export const dynamic = 'force-dynamic'

export default function Page() {
  const picked = cookies().get('demo_subject')?.value
  const me = picked !== undefined && DEMO_SUBJECTS.includes(picked) ? picked : DEMO_SUBJECTS[0] ?? ''
  return <Approvals subjects={DEMO_SUBJECTS} me={me} />
}
