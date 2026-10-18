'use client';

import { DirectionDashboard, FamilyDashboard, FinanceDashboard, SecretariatDashboard, TeacherDashboard, VieScolaireDashboard } from '@/components/espace/dashboards';
import { useAuth } from '@/lib/auth';

export default function Espace() {
  const { role } = useAuth();
  switch (role) {
    case 'DIRECTION': return <DirectionDashboard />;
    case 'SECRETARIAT': return <SecretariatDashboard />;
    case 'ENSEIGNANT': return <TeacherDashboard />;
    case 'VIE_SCOLAIRE': return <VieScolaireDashboard />;
    case 'COMPTABLE': return <FinanceDashboard />;
    default: return <FamilyDashboard />;
  }
}
