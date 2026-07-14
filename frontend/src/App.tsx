import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { RequireAuth } from "./components/RequireAuth";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { PasswordRecovery } from "./pages/PasswordRecovery";
import { InitialSetup } from "./pages/InitialSetup";
import { CompanySettings } from "./pages/CompanySettings";
import { Dashboard } from "./pages/Dashboard";
import { Clients } from "./pages/Clients";
import { ClientDetail } from "./pages/ClientDetail";
import { Jobs } from "./pages/Jobs";
import { JobDetail } from "./pages/JobDetail";
import { Employees } from "./pages/Employees";
import { EmployeeEdit } from "./pages/EmployeeEdit";
import { Calendar } from "./pages/Calendar";
import { ServiceCatalogue } from "./pages/ServiceCatalogue";
import { Quotes } from "./pages/Quotes";
import { QuoteEdit } from "./pages/QuoteEdit";
import { Recruitment } from "./pages/Recruitment";
import { JobOpeningDetail } from "./pages/JobOpeningDetail";
import { Playbooks } from "./pages/Playbooks";
import { PlaybookDetail } from "./pages/PlaybookDetail";
import { LearningRules } from "./pages/LearningRules";
import { Leads } from "./pages/Leads";
import { LeadDetail } from "./pages/LeadDetail";
import { CommunicationLog } from "./pages/CommunicationLog";
import { Notifications } from "./pages/Notifications";
import { DataQuality } from "./pages/DataQuality";
import { Portfolio } from "./pages/Portfolio";
import { PhotoSelection } from "./pages/PhotoSelection";
import { MemoryModel } from "./pages/MemoryModel";
import { BusinessContext } from "./pages/BusinessContext";
import { WebsiteAudits } from "./pages/WebsiteAudits";
import { WebsiteContentProposals } from "./pages/WebsiteContentProposals";
import { Tasks } from "./pages/Tasks";
import { CommunicationIntakePage } from "./pages/CommunicationIntake";
import { Enquiries } from "./pages/Enquiries";
import { Contacts } from "./pages/Contacts";
import { Documents } from "./pages/Documents";
import { Industries } from "./pages/Industries";
import { Connectors } from "./pages/Connectors";
import { Metrics } from "./pages/Metrics";
import { Account } from "./pages/Account";
import { Invoices } from "./pages/Invoices";
import { EmmaPermissions } from "./pages/EmmaPermissions";
import { BuildRefresh } from "./components/BuildRefresh";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <BuildRefresh />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<PasswordRecovery />} />
          <Route path="/reset-password" element={<PasswordRecovery />} />
          <Route path="/setup" element={<InitialSetup />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/clients/:id" element={<ClientDetail />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/documents" element={<Documents />} />
            <Route path="/industries" element={<Industries />} />
            <Route path="/connectors" element={<Connectors />} />
            <Route path="/metrics" element={<Metrics />} />
            <Route path="/account" element={<Account />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/jobs/:id" element={<JobDetail />} />
            <Route path="/employees" element={<Employees />} />
            <Route path="/employees/new" element={<EmployeeEdit />} />
            <Route path="/employees/:id/edit" element={<EmployeeEdit />} />
            <Route path="/company" element={<CompanySettings />} />
            <Route path="/emma-permissions" element={<EmmaPermissions />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/services" element={<ServiceCatalogue />} />
            <Route path="/quotes" element={<Quotes />} />
            <Route path="/quotes/new" element={<QuoteEdit />} />
            <Route path="/quotes/:id" element={<QuoteEdit />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/recruitment" element={<Recruitment />} />
            <Route path="/recruitment/:id" element={<JobOpeningDetail />} />
            <Route path="/playbooks" element={<Playbooks />} />
            <Route path="/playbooks/:id" element={<PlaybookDetail />} />
            <Route path="/learning" element={<LearningRules />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/leads/:id" element={<LeadDetail />} />
            <Route path="/communications" element={<CommunicationLog />} />
            <Route path="/enquiries" element={<Enquiries />} />
            <Route path="/communication-intake" element={<CommunicationIntakePage />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/data-quality" element={<DataQuality />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/photo-selection" element={<PhotoSelection />} />
            <Route path="/memory-model" element={<MemoryModel />} />
            <Route path="/business-context" element={<BusinessContext />} />
            <Route path="/website-audits" element={<WebsiteAudits />} />
            <Route path="/website-content" element={<WebsiteContentProposals />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
