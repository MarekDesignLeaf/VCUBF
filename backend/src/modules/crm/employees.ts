import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CHECK_CAPACITY_ACTION } from "../../lib/actionContracts.js";
import * as employeeService from "../../services/employeeService.js";
import { computeEmployeeCapacity } from "../../services/capacityService.js";

export const employeesRouter = Router();

employeesRouter.use(requireAuth);

// Employee list with each employee's current-week workload attached, so the
// UI can show overload at a glance without a separate round trip per row.
employeesRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  res.json(await employeeService.listEmployees(req.user!));
});

employeesRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const employee = await employeeService.getEmployee(req.user!, req.params.id);
  if (!employee) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(employee);
});

// check_capacity — Action Contract driven, read-only.
employeesRouter.get("/:id/capacity", requirePermission(CHECK_CAPACITY_ACTION.requiredPermission), async (req, res) => {
  const week = typeof req.query.week === "string" ? new Date(req.query.week) : new Date();
  const result = await computeEmployeeCapacity(req.user!, req.params.id, week);
  if (!result) return res.status(404).json({ error: "EMPLOYEE_NOT_FOUND" });
  res.json(result);
});
