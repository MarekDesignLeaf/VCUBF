import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  TASK_CATEGORIES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type Client,
  type Employee,
  type Job,
  type SecretaryTask,
  type TaskCategory,
  type TaskPriority,
  type TaskWriteResult,
} from "../api/client";

export function Tasks() {
  const [tasks, setTasks] = useState<SecretaryTask[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [capacityWarning, setCapacityWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTasks(null);
    api.tasks
      .list({
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
        overdue: overdueOnly || undefined,
      })
      .then((result) => {
        if (!cancelled) setTasks(result);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load tasks.");
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, priorityFilter, overdueOnly]);

  function handleCreated(result: TaskWriteResult) {
    setStatusFilter("");
    setPriorityFilter("");
    setOverdueOnly(false);
    setTasks((current) => [result.task, ...(current ?? []).filter((task) => task.id !== result.task.id)]);
    setShowForm(false);
    setCapacityWarning(
      result.capacityWarning
        ? `${result.capacityWarning.employeeName} is at ${result.capacityWarning.currentLoadHours}h / ${result.capacityWarning.weeklyCapacityHours}h for the task week.`
        : null
    );
  }

  async function changeStatus(task: SecretaryTask, taskStatus: string) {
    setError(null);
    try {
      const result = await api.tasks.update(task.id, { task_status: taskStatus });
      setTasks((current) =>
        (current ?? []).flatMap((currentTask) => {
          if (currentTask.id !== task.id) return [currentTask];
          if (statusFilter && result.task.taskStatus !== statusFilter) return [];
          return [result.task];
        })
      );
      setCapacityWarning(
        result.capacityWarning
          ? `${result.capacityWarning.employeeName} is at ${result.capacityWarning.currentLoadHours}h / ${result.capacityWarning.weeklyCapacityHours}h for the task week.`
          : null
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the task.");
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Tasks</h1>
        <button onClick={() => setShowForm((current) => !current)}>
          {showForm ? "Cancel" : "Create task"}
        </button>
      </div>
      <p className="hint">
        Secretary-owned work items linked to clients, jobs, communication and employees. Assigned tasks with a due
        date appear in Calendar; entered duration contributes to real capacity. Missing duration stays unknown.
      </p>

      {showForm ? <TaskForm onCreated={handleCreated} /> : null}
      {capacityWarning ? <div className="warning-banner">Capacity warning: {capacityWarning}</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}

      <div className="inline-form" style={{ marginTop: 16 }}>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">All statuses</option>
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>{TASK_STATUS_LABELS[status]}</option>
          ))}
        </select>
        <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
          <option value="">All priorities</option>
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>{priority}</option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={overdueOnly} onChange={(event) => setOverdueOnly(event.target.checked)} />{" "}
          Overdue unfinished only
        </label>
      </div>

      {!tasks ? (
        <p>Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="hint">No tasks match the current filters.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Due</th>
              <th>Hours</th>
              <th>Assigned to</th>
              <th>Related record</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <strong>{task.title}</strong>
                  {task.description ? <div className="hint">{task.description}</div> : null}
                </td>
                <td>{TASK_STATUS_LABELS[task.taskStatus]}</td>
                <td>{task.priority}</td>
                <td>{task.dueAt ? new Date(task.dueAt).toLocaleString() : "Unknown"}</td>
                <td>{task.estimatedDurationHours ?? "Unknown"}</td>
                <td>{task.assignedUser?.displayName ?? "Unassigned"}</td>
                <td>
                  {task.job ? <Link to={`/jobs/${task.job.id}`}>{task.job.jobTitle}</Link> : null}
                  {!task.job && task.client ? <Link to={`/clients/${task.client.id}`}>{task.client.displayName}</Link> : null}
                  {!task.job && !task.client ? "—" : null}
                </td>
                <td>
                  {task.taskStatus === "open" ? (
                    <button className="secondary" onClick={() => changeStatus(task, "in_progress")}>Start</button>
                  ) : null}
                  {task.taskStatus !== "completed" && task.taskStatus !== "cancelled" ? (
                    <button onClick={() => changeStatus(task, "completed")}>Complete</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TaskForm({ onCreated }: { onCreated: (result: TaskWriteResult) => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [category, setCategory] = useState<TaskCategory>("administrative");
  const [dueAt, setDueAt] = useState("");
  const [estimatedHours, setEstimatedHours] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");
  const [clientId, setClientId] = useState("");
  const [jobId, setJobId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.clients.list(), api.jobs.list(), api.employees.list()])
      .then(([clientResult, jobResult, employeeResult]) => {
        if (cancelled) return;
        setClients(clientResult);
        setJobs(jobResult);
        setEmployees(employeeResult);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load task links and employees.");
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function changeJob(id: string) {
    setJobId(id);
    if (!id) return;
    const job = jobs.find((candidate) => candidate.id === id);
    if (job) setClientId(job.clientId);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onCreated(
        await api.tasks.create({
          title,
          description: description || undefined,
          priority,
          category,
          source: "user_input",
          due_at: dueAt ? new Date(dueAt).toISOString() : undefined,
          estimated_duration_hours: estimatedHours ? Number(estimatedHours) : undefined,
          assigned_user_id: assignedUserId || undefined,
          client_id: clientId || undefined,
          job_id: jobId || undefined,
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the task.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input placeholder="Task title" value={title} onChange={(event) => setTitle(event.target.value)} required />
      <input placeholder="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
      <select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
        {TASK_PRIORITIES.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <select value={category} onChange={(event) => setCategory(event.target.value as TaskCategory)}>
        {TASK_CATEGORIES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
      </select>
      <label>
        Due
        <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
      </label>
      <input
        type="number"
        min="0.25"
        step="0.25"
        placeholder="Estimated hours"
        value={estimatedHours}
        onChange={(event) => setEstimatedHours(event.target.value)}
      />
      <select value={assignedUserId} onChange={(event) => setAssignedUserId(event.target.value)} disabled={sourcesLoading}>
        <option value="">Unassigned</option>
        {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}
      </select>
      <select value={clientId} onChange={(event) => setClientId(event.target.value)} disabled={sourcesLoading}>
        <option value="">No client</option>
        {clients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}
      </select>
      <select value={jobId} onChange={(event) => changeJob(event.target.value)} disabled={sourcesLoading}>
        <option value="">No job</option>
        {jobs.map((job) => <option key={job.id} value={job.id}>{job.jobTitle}</option>)}
      </select>
      <button type="submit" disabled={submitting || sourcesLoading}>
        {submitting ? "Saving…" : "Create task"}
      </button>
      {error ? <div className="error-banner">{error}</div> : null}
    </form>
  );
}
