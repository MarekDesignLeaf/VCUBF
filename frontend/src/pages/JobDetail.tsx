import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { appLanguage } from "../i18n";
import { JOB_RESOURCE_COPY, resourceReadiness } from "./jobResourceCopy";
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
  const { user } = useAuth();
  const { id } = useParams<{ id: string }>();
  const language = appLanguage(user?.voiceLanguage);
  const resourceCopy = JOB_RESOURCE_COPY[language];
  const canManageResources = user?.permissions.includes("crm.manage") ?? false;
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
  const [resourceQuantity,setResourceQuantity]=useState(""),[resourceUnit,setResourceUnit]=useState(""),[resourceEstimate,setResourceEstimate]=useState("");
  const [resourceError,setResourceError]=useState<string|null>(null),[resourceMessage,setResourceMessage]=useState<string|null>(null),[resourceSaving,setResourceSaving]=useState(false);

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
  useEffect(()=>{if(id)api.jobs.resources(id).then(setResources).catch((reason)=>setResourceError(reason instanceof ApiError?reason.message:resourceCopy.loadError))},[id,resourceCopy.loadError]);
  async function addResource(e:React.FormEvent){
    e.preventDefault();if(!id||!canManageResources)return;
    setResourceSaving(true);setResourceError(null);setResourceMessage(null);
    try{
      await api.jobs.addResource(id,{resource_type:resourceType,name:resourceName.trim(),quantity:resourceQuantity?Number(resourceQuantity):undefined,unit:resourceUnit.trim()||undefined,estimated_cost:resourceEstimate?Number(resourceEstimate):undefined});
      setResourceName("");setResourceQuantity("");setResourceUnit("");setResourceEstimate("");setResources(await api.jobs.resources(id));setResourceMessage(resourceCopy.added);
    }catch(reason){setResourceError(reason instanceof ApiError?reason.message:resourceCopy.addError)}finally{setResourceSaving(false)}
  }
  async function updateResource(resourceId:string,data:Record<string,unknown>){
    if(!id||!canManageResources)return;setResourceSaving(true);setResourceError(null);setResourceMessage(null);
    try{await api.jobs.updateResource(id,resourceId,data);setResources(await api.jobs.resources(id))}catch(reason){setResourceError(reason instanceof ApiError?reason.message:resourceCopy.updateError)}finally{setResourceSaving(false)}
  }
  function setActualCost(resourceId:string,current:number|null|undefined){
    const value=window.prompt(resourceCopy.actualCostPrompt,current?.toString()??"");if(value===null||value.trim()==="")return;
    const amount=Number(value);if(!Number.isFinite(amount)||amount<0){setResourceError(resourceCopy.invalidCost);return}void updateResource(resourceId,{actual_cost:amount});
  }
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
      <div className="page-header"><h2>{resourceCopy.title}</h2></div>
      {resourceError&&<div className="error-banner">{resourceError}</div>}
      {resourceMessage&&<div className="success-banner">{resourceMessage}</div>}
      {resources&&<div className={resources.readiness.ready?"success-banner":"warning-banner"}>{resources.readiness.total===0?resourceCopy.none:resources.readiness.ready?resourceCopy.allReady:resourceReadiness(resourceCopy,resources.readiness.notReady,resources.readiness.total)}</div>}
      {resources?.readiness.total ? <p className="hint">{resourceCopy.estimated}: {resources.readiness.estimatedCost==null?resourceCopy.unknown:`£${resources.readiness.estimatedCost.toFixed(2)}`} · {resourceCopy.actual}: {resources.readiness.actualCost==null?resourceCopy.unknown:`£${resources.readiness.actualCost.toFixed(2)}`} · {resourceCopy.variance}: {resources.readiness.costVariance==null?resourceCopy.unknown:`£${resources.readiness.costVariance.toFixed(2)}`}</p>:null}
      {canManageResources?<form className="inline-form" onSubmit={addResource}>
        <select aria-label={resourceCopy.type} value={resourceType} onChange={e=>setResourceType(e.target.value)} disabled={resourceSaving}>{Object.entries(resourceCopy.types).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select>
        <input aria-label={resourceCopy.requirementName} placeholder={resourceCopy.requirementName} value={resourceName} onChange={e=>setResourceName(e.target.value)} required disabled={resourceSaving}/>
        <input aria-label={resourceCopy.quantity} type="number" min="0.01" step="0.01" placeholder={resourceCopy.quantity} value={resourceQuantity} onChange={e=>setResourceQuantity(e.target.value)} disabled={resourceSaving}/>
        <input aria-label={resourceCopy.unit} placeholder={resourceCopy.unit} value={resourceUnit} onChange={e=>setResourceUnit(e.target.value)} disabled={resourceSaving}/>
        <input aria-label={resourceCopy.estimatedCost} type="number" min="0" step="0.01" placeholder={resourceCopy.estimatedCost} value={resourceEstimate} onChange={e=>setResourceEstimate(e.target.value)} disabled={resourceSaving}/>
        <button type="submit" disabled={resourceSaving}>{resourceSaving?resourceCopy.adding:resourceCopy.add}</button>
      </form>:<p className="hint">{resourceCopy.noPermission}</p>}
      {resources&&resources.items.length>0&&<table className="data-table"><thead><tr><th>{resourceCopy.type}</th><th>{resourceCopy.name}</th><th>{resourceCopy.quantity}</th><th>{resourceCopy.status}</th><th>{resourceCopy.estimated}</th><th>{resourceCopy.actual}</th></tr></thead><tbody>{resources.items.map(r=><tr key={r.id}><td>{resourceCopy.types[r.resourceType]??r.resourceType}</td><td>{r.name}</td><td>{r.quantity??"—"} {r.unit??""}</td><td><select aria-label={`${resourceCopy.status}: ${r.name}`} value={r.requirementStatus} onChange={e=>void updateResource(r.id,{requirement_status:e.target.value})} disabled={!canManageResources||resourceSaving}>{Object.entries(resourceCopy.statuses).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></td><td>{r.estimatedCost==null?resourceCopy.unknown:`£${r.estimatedCost.toFixed(2)}`}</td><td><button type="button" disabled={!canManageResources||resourceSaving} onClick={()=>setActualCost(r.id,r.actualCost)}>{r.actualCost==null?resourceCopy.setCost:`£${r.actualCost.toFixed(2)}`}</button></td></tr>)}</tbody></table>}

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
