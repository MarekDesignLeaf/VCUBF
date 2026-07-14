import { Router } from "express";
import { ACCESS_PROFILES, CHECK_CAPACITY_ACTION, CREATE_EMPLOYEE_ACTION, KNOWN_PERMISSIONS, RESET_EMPLOYEE_PASSWORD_ACTION, UPDATE_EMPLOYEE_ACTION } from "../../lib/actionContracts.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { computeEmployeeCapacity } from "../../services/capacityService.js";
import * as employeeService from "../../services/employeeService.js";

export const employeesRouter = Router();
employeesRouter.use(requireAuth);

// Metadata must be registered before /:id so Express never treats "meta" as
// an employee id. The UI uses these definitions to show profile templates and
// the exact optional permissions that the backend understands.
employeesRouter.get("/meta/permissions", requirePermission("users.manage"), async (_req, res) => {
  res.json(KNOWN_PERMISSIONS);
});

employeesRouter.get("/meta/access-profiles", requirePermission("users.manage"), async (_req, res) => {
  res.json(ACCESS_PROFILES);
});

employeesRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  res.json(await employeeService.listEmployees(req.user!));
});

employeesRouter.post("/", requirePermission(CREATE_EMPLOYEE_ACTION.requiredPermission), async (req, res) => {
  const result = await employeeService.createEmployee(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

employeesRouter.get("/:id/manage", requirePermission("users.manage"), async (req, res) => {
  const employee = await employeeService.getEmployeeForManagement(req.user!, req.params.id);
  if (!employee) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(employee);
});

employeesRouter.post("/:id/reset-password", requirePermission(RESET_EMPLOYEE_PASSWORD_ACTION.requiredPermission), async (req, res) => {
  const result = await employeeService.resetEmployeePassword(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

employeesRouter.put("/:id", requirePermission(UPDATE_EMPLOYEE_ACTION.requiredPermission), async (req, res) => {
  const result = await employeeService.updateEmployee(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

employeesRouter.get("/:id/capacity", requirePermission(CHECK_CAPACITY_ACTION.requiredPermission), async (req, res) => {
  const week = typeof req.query.week === "string" ? new Date(req.query.week) : new Date();
  const result = await computeEmployeeCapacity(req.user!, req.params.id, week);
  if (!result) return res.status(404).json({ error: "EMPLOYEE_NOT_FOUND" });
  res.json(result);
});

employeesRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const employee = await employeeService.getEmployee(req.user!, req.params.id);
  if (!employee) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(employee);
});
