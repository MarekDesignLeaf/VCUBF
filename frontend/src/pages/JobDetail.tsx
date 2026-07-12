import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  api,
  type Job,
  type Employee,
  type CommunicationRecord,
  type PortfolioPhoto,
  type JobResources,
  JOB_STATUSES,
  JOB_STATUS_LABELS,
  COMMUNICATION_CHANNEL_LABELS,
  ApiError,
} from "../api/client";

export function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [assignWarning, setAssignWarning] = useState<string | null>(null);
  const [missingSkills, setMissingSkills] = useState<string[]>([]);
  const [communications, setCommunications] = useState<CommunicationRecord[]>([]);
  const [photos, setPhotos] = useState<PortfolioPhoto[]>([]);
  const [resources,setResources]=useState<JobResources|null>(null);
  const [resourceName,setResourceName]=useState(""); const [resourceType,setResourceType]=useState("material");

  function load() {
    if (!id) return;
    api.jobs
      .get(id)
      .then(setJob)
      .catch(() => setError("Job not found."));
  }

  useEffect(load, [id]);
  useEffect(() => {
    api.employees.list().then(setEmployees).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!id) return;
    api.communications.list({ jobId: id }).then(setCommunications).catch(() => undefined);
  }, [id]);
  useEffect(()=>{if(id)api.jobs.resources(id).then(setResources).catch(()=>undefined)},[id]);
  async function addResource(e:React.FormEvent){e.preventDefault();if(!id)return;await api.jobs.addResource(id,{resource_type:resourceType,name:resourceName});setResourceName("");setResources(await api.jobs.resources(id))}
  async function ready(resourceId:string){if(!id)return;await api.jobs.updateResource(id,resourceId,{requirement_status:"ready"});setResources(await api.jobs.resources(id))}
  useEffect(() => {
    if (!id) return;
    api.portfolio.list({ jobId: id }).then(setPhotos).catch(() => undefined);
  }, [id]);

  async function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    if (!job) return;
    const newStatus = e.target.value as Job["jobStatus"];
    setUpdating(true);
    setError(null);
    try {
      const updated = await api.jobs.changeStatus(job.id, newStatus);
      setJob(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change status.");
    } finally {
      setUpdating(false);
    }
  }

  async function handleAssign(e: React.ChangeEvent<HTMLSelectElement>) {
    if (!job) return;
    const employeeId = e.target.value;
    if (!employeeId) return;
    setUpdating(true);
    setError(null);
    setAssignWarning(null);
    setMissingSkills([]);
    try {
      const result = await api.jobs.assign(job.id, employeeId);
      setJob(result.job);
      setMissingSkills(result.missingSkills ?? []);
      if (result.capacityWarning?.type === "OVERLOAD") {
        const employeeName = result.capacityWarning.employeeName as string;
        const projectedLoadHours = result.capacityWarning.projectedLoadHours as number;
        const weeklyCapacityHours = result.capacityWarning.weeklyCapacityHours as number;
        setAssignWarning(
          "This assignment would put " +
            employeeName +
            " at " +
            projectedLoadHours +
            "h against a " +
            weeklyCapacityHours +
            "h weekly capacity - they are overloaded this week."
        );
      } else if (result.capacityWarning?.type === "NO_PLANNED_DATE") {
        setAssignWarning("Job has no planned start date - capacity could not be evaluated for this assignment.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not assign job.");
    } finally {
      setUpdating(false);
    }
  }

  if (error && !job) return <div className="error-banner">{error}</div>;
  if (!job) return <p>Loading…</p>;

  const assignedEmployee = employees.find((e) => e.id === job.assignedUserId);

  return (
    <div>
      <Link to="/jobs">← Back to jobs</Link>
      <div className="page-header">
        <h1>{job.jobTitle}</h1>
        <Link to={`/quotes/new?client_id=${job.clientId}&job_id=${job.id}`}>New quote for this job</Link>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {assignWarning && <div className="warning-banner">{assignWarning}</div>}
      {missingSkills.length > 0 && (
        <div className="warning-banner">
          Assigned employee is missing required skill(s): {missingSkills.join(", ")}.
        </div>
      )}
      <dl className="detail-list">
        <dt>Client</dt>
        <dd>
          {job.client ? <Link to={`/clients/${job.client.id}`}>{job.client.displayName}</Link> : "—"}
        </dd>
        <dt>Status</dt>
        <dd>
          <select value={job.jobStatus} onChange={handleStatusChange} disabled={updating}>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {JOB_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </dd>
        <dt>Assigned to</dt>
        <dd>
          <select value={job.assignedUserId ?? ""} onChange={handleAssign} disabled={updating || job.jobStatus !== "prijato"}>
            <option value="">— Unassigned —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.displayName}
                {e.capacity?.overloaded ? " (overloaded)" : ""}
              </option>
            ))}
          </select>
          {assignedEmployee && <span className="hint"> — {assignedEmployee.role}</span>}
          {!assignedEmployee && job.jobStatus !== "prijato" && <span className="hint"> — Set status to Accepted before assignment.</span>}
        </dd>
        <dt>Address</dt>
        <dd>{job.propertyAddress ?? "—"}</dd>
        <dt>Est. hours</dt>
        <dd>{job.estimatedDurationHours ?? "—"}</dd>
        <dt>Required skills</dt>
        <dd>
          {job.requiredSkills && job.requiredSkills.length > 0 ? (
            job.requiredSkills.map((s) => (
              <span className="skill-tag" key={s}>
                {s}
              </span>
            ))
          ) : (
            "—"
          )}
        </dd>
        <dt>Notes</dt>
        <dd>{job.notes ?? "—"}</dd>
      </dl>
      <div className="page-header"><h2>Materials and resources</h2></div>
      {resources&&<div className={resources.readiness.ready?"success-banner":"warning-banner"}>{resources.readiness.total===0?"No resource requirements recorded.":resources.readiness.ready?"All recorded resources are ready.":`${resources.readiness.notReady} of ${resources.readiness.total} resources are not ready.`}</div>}
      <form className="inline-form" onSubmit={addResource}><select value={resourceType} onChange={e=>setResourceType(e.target.value)}><option value="material">Material</option><option value="equipment">Equipment</option><option value="vehicle">Vehicle</option><option value="hire">Hire</option><option value="waste">Waste</option></select><input placeholder="Requirement name" value={resourceName} onChange={e=>setResourceName(e.target.value)} required/><button>Add</button></form>
      {resources&&resources.items.length>0&&<table className="data-table"><thead><tr><th>Type</th><th>Name</th><th>Status</th><th>Cost</th><th></th></tr></thead><tbody>{resources.items.map(r=><tr key={r.id}><td>{r.resourceType}</td><td>{r.name}</td><td>{r.requirementStatus}</td><td>{r.estimatedCost==null?"Unknown":`£${r.estimatedCost.toFixed(2)}`}</td><td>{r.requirementStatus!=="ready"&&<button onClick={()=>ready(r.id)}>Mark ready</button>}</td></tr>)}</tbody></table>}

      <div className="page-header">
        <h2>Communications</h2>
        <Link to={`/communications?client_id=${job.clientId}&job_id=${job.id}`}>Log communication</Link>
      </div>
      {communications.length === 0 ? (
        <p className="hint">No communications logged for this job yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Channel</th>
              <th>Summary</th>
              <th>Follow-up</th>
            </tr>
          </thead>
          <tbody>
            {communications.slice(0, 5).map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.occurredAt).toLocaleString()}</td>
                <td>{COMMUNICATION_CHANNEL_LABELS[c.channel]}</td>
                <td>{c.summary}</td>
                <td>{c.followUpNeeded ? "Needed" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="page-header">
        <h2>Photos</h2>
        <Link to={`/portfolio?client_id=${job.clientId}&job_id=${job.id}`}>Log photo</Link>
      </div>
      {photos.length === 0 ? (
        <p className="hint">No photos logged for this job yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Caption</th>
              <th>Marketing</th>
            </tr>
          </thead>
          <tbody>
            {photos.slice(0, 5).map((p) => (
              <tr key={p.id}>
                <td>{p.filename}</td>
                <td>{p.caption ?? "—"}</td>
                <td>{p.usableForMarketing ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
