import { isMfaEnrollmentAllowedPath, normalizeRequestPath } from "../mfaEnrollment";
import { mfaRequiredForRole } from "../../services/mfaService";

describe("isMfaEnrollmentAllowedPath", () => {
  it("allows MFA setup endpoints", () => {
    expect(isMfaEnrollmentAllowedPath("GET", "/api/auth/mfa/status")).toBe(true);
    expect(isMfaEnrollmentAllowedPath("POST", "/api/auth/mfa/setup")).toBe(true);
    expect(isMfaEnrollmentAllowedPath("POST", "/api/auth/mfa/confirm?x=1")).toBe(true);
    expect(isMfaEnrollmentAllowedPath("POST", "/api/auth/change-password")).toBe(true);
    expect(isMfaEnrollmentAllowedPath("GET", "/api/auth/profile")).toBe(true);
  });

  it("blocks money and ops APIs", () => {
    expect(isMfaEnrollmentAllowedPath("POST", "/api/invoices/external/dunning/run")).toBe(false);
    expect(isMfaEnrollmentAllowedPath("GET", "/api/users")).toBe(false);
    expect(isMfaEnrollmentAllowedPath("POST", "/api/auth/mfa/disable")).toBe(false);
  });

  it("normalizes trailing slashes", () => {
    expect(normalizeRequestPath("/api/auth/mfa/status/")).toBe("/api/auth/mfa/status");
  });
});

describe("mfaRequiredForRole", () => {
  const prev = process.env.MFA_REQUIRED_ROLES;

  afterEach(() => {
    if (prev === undefined) delete process.env.MFA_REQUIRED_ROLES;
    else process.env.MFA_REQUIRED_ROLES = prev;
  });

  it("is off when the env list is empty", () => {
    delete process.env.MFA_REQUIRED_ROLES;
    expect(mfaRequiredForRole("admin")).toBe(false);
  });

  it("matches listed roles case-insensitively", () => {
    process.env.MFA_REQUIRED_ROLES = "admin, manager";
    expect(mfaRequiredForRole("Admin")).toBe(true);
    expect(mfaRequiredForRole("collector")).toBe(false);
  });
});
