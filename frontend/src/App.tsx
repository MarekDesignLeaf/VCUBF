import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { RequireAuth } from "./components/RequireAuth";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { PasswordRecovery } from "./pages/PasswordRecovery";
import { InitialSetup } from "./pages/InitialSetup";
import { BuildRefresh } from "./components/BuildRefresh";
import { LocalizedSurface } from "./components/LocalizedSurface";
import { useAuth } from "./context/useAuth";
import { DEFAULT_ASSISTANT_NAME } from "./assistantName";
import { appLanguage } from "./i18n";

const CompanySettings = lazy(() => import("./pages/CompanySettings").then(({ CompanySettings }) => ({ default: CompanySettings })));
const Dashboard = lazy(() => import("./pages/Dashboard").then(({ Dashboard }) => ({ default: Dashboard })));
const Clients = lazy(() => import("./pages/Clients").then(({ Clients }) => ({ default: Clients })));
const ClientDetail = lazy(() => import("./pages/ClientDetail").then(({ ClientDetail }) => ({ default: ClientDetail })));
const Jobs = lazy(() => import("./pages/Jobs").then(({ Jobs }) => ({ default: Jobs })));
const JobDetail = lazy(() => import("./pages/JobDetail").then(({ JobDetail }) => ({ default: JobDetail })));
const Employees = lazy(() => import("./pages/Employees").then(({ Employees }) => ({ default: Employees })));
const EmployeeEdit = lazy(() => import("./pages/EmployeeEdit").then(({ EmployeeEdit }) => ({ default: EmployeeEdit })));
const Calendar = lazy(() => import("./pages/Calendar").then(({ Calendar }) => ({ default: Calendar })));
const ServiceCatalogue = lazy(() => import("./pages/ServiceCatalogue").then(({ ServiceCatalogue }) => ({ default: ServiceCatalogue })));
const Quotes = lazy(() => import("./pages/Quotes").then(({ Quotes }) => ({ default: Quotes })));
const QuoteEdit = lazy(() => import("./pages/QuoteEdit").then(({ QuoteEdit }) => ({ default: QuoteEdit })));
const Recruitment = lazy(() => import("./pages/Recruitment").then(({ Recruitment }) => ({ default: Recruitment })));
const JobOpeningDetail = lazy(() => import("./pages/JobOpeningDetail").then(({ JobOpeningDetail }) => ({ default: JobOpeningDetail })));
const Playbooks = lazy(() => import("./pages/Playbooks").then(({ Playbooks }) => ({ default: Playbooks })));
const PlaybookDetail = lazy(() => import("./pages/PlaybookDetail").then(({ PlaybookDetail }) => ({ default: PlaybookDetail })));
const LearningRules = lazy(() => import("./pages/LearningRules").then(({ LearningRules }) => ({ default: LearningRules })));
const Leads = lazy(() => import("./pages/Leads").then(({ Leads }) => ({ default: Leads })));
const LeadDetail = lazy(() => import("./pages/LeadDetail").then(({ LeadDetail }) => ({ default: LeadDetail })));
const CommunicationLog = lazy(() => import("./pages/CommunicationLog").then(({ CommunicationLog }) => ({ default: CommunicationLog })));
const Notifications = lazy(() => import("./pages/Notifications").then(({ Notifications }) => ({ default: Notifications })));
const DataQuality = lazy(() => import("./pages/DataQuality").then(({ DataQuality }) => ({ default: DataQuality })));
const Portfolio = lazy(() => import("./pages/Portfolio").then(({ Portfolio }) => ({ default: Portfolio })));
const PhotoSelection = lazy(() => import("./pages/PhotoSelection").then(({ PhotoSelection }) => ({ default: PhotoSelection })));
const MemoryModel = lazy(() => import("./pages/MemoryModel").then(({ MemoryModel }) => ({ default: MemoryModel })));
const BusinessContext = lazy(() => import("./pages/BusinessContext").then(({ BusinessContext }) => ({ default: BusinessContext })));
const WebsiteAudits = lazy(() => import("./pages/WebsiteAudits").then(({ WebsiteAudits }) => ({ default: WebsiteAudits })));
const WebsiteContentProposals = lazy(() => import("./pages/WebsiteContentProposals").then(({ WebsiteContentProposals }) => ({ default: WebsiteContentProposals })));
const Tasks = lazy(() => import("./pages/Tasks").then(({ Tasks }) => ({ default: Tasks })));
const CommunicationIntakePage = lazy(() => import("./pages/CommunicationIntake").then(({ CommunicationIntakePage }) => ({ default: CommunicationIntakePage })));
const Enquiries = lazy(() => import("./pages/Enquiries").then(({ Enquiries }) => ({ default: Enquiries })));
const Contacts = lazy(() => import("./pages/Contacts").then(({ Contacts }) => ({ default: Contacts })));
const Documents = lazy(() => import("./pages/Documents").then(({ Documents }) => ({ default: Documents })));
const Industries = lazy(() => import("./pages/Industries").then(({ Industries }) => ({ default: Industries })));
const Connectors = lazy(() => import("./pages/Connectors").then(({ Connectors }) => ({ default: Connectors })));
const Metrics = lazy(() => import("./pages/Metrics").then(({ Metrics }) => ({ default: Metrics })));
const Account = lazy(() => import("./pages/Account").then(({ Account }) => ({ default: Account })));
const Invoices = lazy(() => import("./pages/Invoices").then(({ Invoices }) => ({ default: Invoices })));
const EmmaPermissions = lazy(() => import("./pages/EmmaPermissions").then(({ EmmaPermissions }) => ({ default: EmmaPermissions })));
const VoiceAliases = lazy(() => import("./pages/VoiceAliases").then(({ VoiceAliases }) => ({ default: VoiceAliases })));

function ApplicationRoutes() {
  const { user } = useAuth();
  const language = appLanguage(user?.voiceLanguage ?? window.localStorage.getItem("vcubf_last_language"));
  const assistantName = (user?.assistantName ?? "").trim() || DEFAULT_ASSISTANT_NAME;

  return (
    <>
      <LocalizedSurface language={language} assistantName={assistantName} />
      <BrowserRouter>
        <BuildRefresh />
        <Suspense fallback={<div aria-busy="true" className="route-loading" />}>
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
            <Route path="/voice-aliases" element={<VoiceAliases />} />
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
        </Suspense>
      </BrowserRouter>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ApplicationRoutes />
    </AuthProvider>
  );
}
