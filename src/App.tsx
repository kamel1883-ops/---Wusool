import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session';
import { FullPageLoading } from './components/Shell';
import {
  AccessDeniedPage,
  ChangePasswordPage,
  ForgotPage,
  LandingPage,
  LoginPage,
  NotFoundPage,
  PrivacyPage,
  SetupPage,
  SupportPage,
  TermsPage,
} from './pages/Public';
import {
  CompanyActivityPage,
  CompanyDashboardPage,
  CompanyLayout,
  CompanyProfilePage,
  CompanyRedirect,
  CompanySettingsPage,
  CompanySubscriptionPage,
  CompanyTeamPage,
} from './pages/CompanyPages';
import {
  AdminAuditPage,
  AdminCompaniesPage,
  AdminCompanyDetailPage,
  AdminInvoicesPage,
  AdminLayout,
  AdminOverviewPage,
  AdminPlansPage,
  AdminSettingsPage,
  AdminUsagePage,
  AdminUsersPage,
} from './pages/AdminPages';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading, t } = useSession();
  const location = useLocation();

  if (loading) return <FullPageLoading label={t('common.loading')} />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { me, loading, t } = useSession();
  if (loading) return <FullPageLoading label={t('common.loading')} />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.platformRole !== 'super_admin') return <AccessDeniedPage />;
  return <>{children}</>;
}

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot" element={<ForgotPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/support" element={<SupportPage />} />

          <Route
            path="/change-password"
            element={
              <RequireAuth>
                <ChangePasswordPage />
              </RequireAuth>
            }
          />

          <Route
            path="/app"
            element={
              <RequireAuth>
                <CompanyRedirect />
              </RequireAuth>
            }
          />
          <Route
            path="/app/:companyId"
            element={
              <RequireAuth>
                <CompanyLayout />
              </RequireAuth>
            }
          >
            <Route index element={<CompanyDashboardPage />} />
            <Route path="company" element={<CompanyProfilePage />} />
            <Route path="team" element={<CompanyTeamPage />} />
            <Route path="subscription" element={<CompanySubscriptionPage />} />
            <Route path="activity" element={<CompanyActivityPage />} />
            <Route path="settings" element={<CompanySettingsPage />} />
          </Route>

          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminLayout />
              </RequireAdmin>
            }
          >
            <Route index element={<AdminOverviewPage />} />
            <Route path="companies" element={<AdminCompaniesPage />} />
            <Route path="companies/:companyId" element={<AdminCompanyDetailPage />} />
            <Route path="invoices" element={<AdminInvoicesPage />} />
            <Route path="plans" element={<AdminPlansPage />} />
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="usage" element={<AdminUsagePage />} />
            <Route path="audit" element={<AdminAuditPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
