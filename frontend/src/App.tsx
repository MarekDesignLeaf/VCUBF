import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { RequireAuth } from "./components/RequireAuth";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
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
import { Leads } from "./pages/Leads";
import { LeadDetail } from "./pages/LeadDetail";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
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
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/jobs/:id" element={<JobDetail />} />
            <Route path="/employees" element={<Employees />} />
            <Route path="/employees/new" element={<EmployeeEdit />} />
            <Route path="/employees/:id/edit" element={<EmployeeEdit />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/services" element={<ServiceCatalogue />} />
            <Route path="/quotes" element={<Quotes />} />
            <Route path="/quotes/new" element={<QuoteEdit />} />
            <Route path="/quotes/:id" element={<QuoteEdit />} />
            <Route path="/recruitment" element={<Recruitment />} />
            <Route path="/recruitment/:id" element={<JobOpeningDetail />} />
            <Route path="/playbooks" element={<Playbooks />} />
            <Route path="/playbooks/:id" element={<PlaybookDetail />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/leads/:id" element={<LeadDetail />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
