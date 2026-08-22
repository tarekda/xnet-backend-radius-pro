/// <reference path="../../types/express.d.ts" />
import { Request, Response } from 'express';
// ...
import jwt from 'jsonwebtoken';
import { SystemUsers } from '../db/entities/SystemUsers'; // Assuming you have a User entity defined
import * as bcrypt from 'bcryptjs';
import { RefreshTokens } from '../db/entities/RefreshTokens';
import { AppDataSource } from '../db/config';
import { body, validationResult } from 'express-validator';
import { Equal } from 'typeorm';
import { getEffectivePermissionsForUser } from '../access/permissionService';

import { getJwtSecret, getRefreshTokenSecret } from '../config/requireSecrets';
import { validateStaffPassword } from '../auth/staffPasswordPolicy';
import { clearStaffLoginFailures, getStaffLoginLock, recordStaffLoginFailure } from '../auth/staffLoginLockout';
import { writeAuditLog } from '../audit/writeAuditLog';

const jwtSecret = getJwtSecret();
const refreshTokenSecret = getRefreshTokenSecret();
/** Refresh tokens expire; rotation on /refresh-token issues a new one. */
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '30d';
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '1d';

const sendResponse = (res: Response, success: boolean, status: number, message: string, data: any = null) => {
    res.status(status).json({ success, message, data });
};

/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get all authenticated users with pagination
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of users per page
 *     responses:
 *       200:
 *         description: List of authenticated users
 */
export const getAllUsers = async (req: Request, res: Response) => {
    const userRepository = AppDataSource.getRepository(SystemUsers);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = (page - 1) * limit;

    try {
        // IMPORTANT: never return password hashes to clients
        const [users, total] = await userRepository.findAndCount({
            select: [
                "id",
                "username",
                "email",
                "role",
                "resellerId",
                "mustChangePassword",
                "passwordChangedAt",
                "isActive",
                "createdAt",
                "updatedAt",
                "lastLogin",
            ] as any,
            skip: offset,
            take: limit,
        });

        const totalPages = Math.ceil(total / limit);

        sendResponse(res, true, 200, 'Users fetched successfully', {
            users,
            total,
            page,
            totalPages,
        });
    } catch (error) {
        sendResponse(res, false, 500, 'Internal server error');
    }
};

/**
 * @swagger
 * /register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       201:
 *         description: User registered successfully
 *       409:
 *         description: User already exists
 */
export const register = [
    body('username').isString().notEmpty(),
    body('email').optional().custom((value) => {
        if (value === '' || value === null || value === undefined) {
            return true; // Allow empty string, null, or undefined
        }
        if (typeof value === 'string' && value.trim().length > 0) {
            // Use a regex or a library like validator.js to check if it's a valid email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (emailRegex.test(value)) {
                return true;
            }
        }
        throw new Error('Invalid email');
    }), // Email is optional,
    body('password').isString().custom((value) => {
        const check = validateStaffPassword(String(value || ""));
        if (!check.ok) throw new Error(check.message);
        return true;
    }),
    body('role').optional().isString().isIn(['admin', 'manager', 'support', 'collector', 'reseller']),
    body('isActive').optional().isBoolean(),
    async (req: Request, res: Response) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return sendResponse(res, false, 400, 'Validation errors', errors.array());
        }

        const { username, email, password, role, isActive } = req.body;
        const userRepository = AppDataSource.getRepository(SystemUsers);

        try {
            const existingUser = await userRepository.findOne({ where: [{ username }, { email }] });
            if (existingUser) {
                return sendResponse(res, false, 409, 'User already exists');
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            const newUser = userRepository.create({
                username,
                email,
                password: hashedPassword,
                role,
                isActive: typeof isActive === "boolean" ? isActive : true,
                mustChangePassword: false,
                passwordChangedAt: new Date(),
            });
            await userRepository.save(newUser);

            sendResponse(res, true, 201, 'User registered successfully');
        } catch (error) {
            sendResponse(res, false, 500, 'Internal server error');
        }
    }];

/**
 * @swagger
 * /update-user:
 *   put:
 *     summary: Update an existing user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *     responses:
 *       200:
 *         description: User updated successfully
 *       400:
 *         description: Validation errors
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
export const updateUser = [
    body('username').isString().notEmpty(),
    body('email').optional().custom((value) => {
        if (value === '' || value === null || value === undefined) {
            return true; // Allow empty string, null, or undefined
        }
        if (typeof value === 'string' && value.trim().length > 0) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (emailRegex.test(value)) {
                return true;
            }
        }
        throw new Error('Invalid email');
    }),
    body('password').optional().isString().custom((value) => {
        // Treat empty string as "not provided" (frontend uses blank for no change)
        if (value === "" || value === null || value === undefined) return true;
        const check = validateStaffPassword(String(value));
        if (!check.ok) throw new Error(check.message);
        return true;
    }),
    body('role').optional().isString().isIn(['admin', 'manager', 'support', 'collector', 'reseller']),
    body('isActive').optional().isBoolean(),
    body('mustChangePassword').optional().isBoolean(),
    async (req: Request, res: Response) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return sendResponse(res, false, 400, 'Validation errors', errors.array());
        }

        const { username, email, password, role, isActive, mustChangePassword } = req.body;
        const userRepository = AppDataSource.getRepository(SystemUsers);

        try {
            const user = await userRepository.findOne({ where: { username } });
            if (!user) {
                return sendResponse(res, false, 404, 'User not found');
            }

            if (email !== undefined) user.email = email;
            if (typeof password === "string" && password.length > 0) {
                user.password = await bcrypt.hash(password, 10);
                (user as any).passwordChangedAt = new Date();
            }
            if (role !== undefined) user.role = role;
            if (typeof isActive === "boolean") user.isActive = isActive;
            if (typeof mustChangePassword === "boolean") (user as any).mustChangePassword = mustChangePassword;
            user.updatedAt = new Date();

            await userRepository.save(user);

            sendResponse(res, true, 200, 'User updated successfully');
        } catch (error) {
            sendResponse(res, false, 500, 'Internal server error');
        }
    }
];

/**
 * POST /api/auth/users/:id/reset-password
 * Body: { newPassword: string, mustChangePassword?: boolean }
 * Requires: admin.authUsers.manage
 */
export const adminResetUserPassword = async (req: Request, res: Response) => {
    const userId = Number(req.params.id);
    const { newPassword, mustChangePassword } = req.body ?? {};

    if (!Number.isFinite(userId)) return sendResponse(res, false, 400, "Invalid id");
    const passwordCheck = validateStaffPassword(typeof newPassword === "string" ? newPassword : "");
    if (!passwordCheck.ok) {
        return sendResponse(res, false, 400, passwordCheck.message);
    }

    const userRepository = AppDataSource.getRepository(SystemUsers);
    try {
        const user = await userRepository.findOne({ where: { id: userId } });
        if (!user) return sendResponse(res, false, 404, "User not found");

        user.password = await bcrypt.hash(newPassword, 10);
        (user as any).passwordChangedAt = new Date();
        (user as any).mustChangePassword = typeof mustChangePassword === "boolean" ? mustChangePassword : true;
        user.updatedAt = new Date();
        await userRepository.save(user);

        return sendResponse(res, true, 200, "Password reset successfully", {
            id: user.id,
            username: user.username,
            mustChangePassword: Boolean((user as any).mustChangePassword),
            passwordChangedAt: (user as any).passwordChangedAt,
        });
    } catch (e) {
        return sendResponse(res, false, 500, "Internal server error");
    }
};

// Postman request body example for registering a user
/*
{
    "username": "exampleUser",
    "email": "user@example.com",
    "password": "examplePassword"
}
*/

// Postman request body example for logging in a user
/*
{
    "username": "exampleUser",
    "password": "examplePassword"
}
*/

/**
 * @swagger
 * /login:
 *   post:
 *     summary: Login a user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
export const login = async (req: Request, res: Response) => {
    const { username, password } = req.body;
    const userRepository = AppDataSource.getRepository(SystemUsers);
    const refreshTokenRepository = AppDataSource.getRepository(RefreshTokens);

    try {

        // 2️⃣ normalise (optional but recommended)
        const lookup = String(username || "").trim().toLowerCase();
        if (!lookup || typeof password !== "string") {
            return sendResponse(res, false, 400, "username and password are required");
        }

        const lock = await getStaffLoginLock(lookup);
        if (lock.locked) {
            return sendResponse(res, false, 423, lock.message || "Account locked");
        }

        const user = await userRepository.findOne({
            where: { username: Equal(lookup) },
        });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            const next = await recordStaffLoginFailure(lookup);
            if (next.locked) {
                return sendResponse(res, false, 423, next.message || "Account locked");
            }
            return sendResponse(res, false, 401, 'Invalid credentials');
        }

        await clearStaffLoginFailures(lookup);
        const { completeLoginAfterPassword } = await import('./mfaController');
        await completeLoginAfterPassword(user, res, 'web');
    } catch (error) {
        console.error('Login failed');
        sendResponse(res, false, 500, 'Internal server error');
    }
};

/**
 * @swagger
 * /refresh-token:
 *   post:
 *     summary: Refresh access token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *       401:
 *         description: Token is required
 *       403:
 *         description: Invalid refresh token
 */
export const refreshToken = async (req: Request, res: Response) => {
    const { token } = req.body;
    const refreshTokenRepository = AppDataSource.getRepository(RefreshTokens);

    if (!token) return sendResponse(res, false, 401, 'Token is required');

    try {
        const storedToken = await refreshTokenRepository.findOne({ where: { token }, relations: ["user"] });
        if (!storedToken) return sendResponse(res, false, 403, 'Invalid refresh token');
        if (storedToken.revokedAt) return sendResponse(res, false, 403, 'Refresh token has been revoked');

        jwt.verify(token, refreshTokenSecret, async (err: any, user: any) => {
            if (err) return sendResponse(res, false, 403, 'Invalid refresh token');

            // Rotate the refresh token
            const username = storedToken.user?.username ?? user?.username;
            const role = storedToken.user?.role ?? user?.role;
            const id = storedToken.user?.id ?? user?.id;
            const resellerId = (storedToken.user as any)?.resellerId ?? user?.resellerId ?? null;
            const newRefreshToken = jwt.sign(
                { id, username, role, resellerId },
                refreshTokenSecret,
                { expiresIn: REFRESH_TOKEN_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
            );
            storedToken.token = newRefreshToken;
            storedToken.createdAt = new Date();
            await refreshTokenRepository.save(storedToken);

            const accessToken = jwt.sign(
                { id, username, role, resellerId },
                jwtSecret,
                { expiresIn: '15m' }
            );
            sendResponse(res, true, 200, 'Token refreshed successfully', { accessToken, refreshToken: newRefreshToken });
        });
    } catch (error) {
        sendResponse(res, false, 500, 'Internal server error');
    }
};

/**
 * @swagger
 * /logout:
 *   post:
 *     summary: Logout a user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       204:
 *         description: Logged out successfully
 */
export const logout = async (req: Request, res: Response) => {
    const { token } = req.body;
    const refreshTokenRepository = AppDataSource.getRepository(RefreshTokens);

    try {
        await refreshTokenRepository.delete({ token });
        sendResponse(res, true, 204, 'Logged out successfully');
    } catch (error) {
        sendResponse(res, false, 500, 'Internal server error');
    }
};

/**
 * @swagger
 * /profile:
 *   get:
 *     summary: Get user profile
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Profile fetched successfully
 */
export const profile = async (req: Request, res: Response) => {
    const userRepository = AppDataSource.getRepository(SystemUsers);

    try {
        const user = await userRepository.findOne({ where: { username: req.user?.username } });
        if (!user) {
            return sendResponse(res, false, 404, 'User not found');
        }

        const permissions = await getEffectivePermissionsForUser({
            userId: (req.user as any)?.id ?? user.id,
            username: user.username,
            roleKey: user.role ?? undefined,
        });

        sendResponse(res, true, 200, 'Profile fetched successfully', {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            resellerId: (user as any).resellerId ?? null,
            mustChangePassword: Boolean((user as any).mustChangePassword),
            permissions,
        });
    } catch (error) {
        sendResponse(res, false, 500, 'Internal server error');
    }
};

/**
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 * Requires: Bearer token
 */
export const changePassword = async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
        return sendResponse(res, false, 400, 'currentPassword is required');
    }
    const passwordCheck = validateStaffPassword(typeof newPassword === "string" ? newPassword : "");
    if (!passwordCheck.ok) {
        return sendResponse(res, false, 400, passwordCheck.message);
    }

    const userRepository = AppDataSource.getRepository(SystemUsers);

    try {
        const username = (req.user as any)?.username;
        if (!username) return sendResponse(res, false, 401, 'Unauthorized');

        const user = await userRepository.findOne({ where: { username } });
        if (!user) return sendResponse(res, false, 404, 'User not found');

        const ok = await bcrypt.compare(currentPassword, user.password);
        if (!ok) return sendResponse(res, false, 401, 'Invalid credentials');

        user.password = await bcrypt.hash(newPassword, 10);
        (user as any).mustChangePassword = false;
        (user as any).passwordChangedAt = new Date();
        user.updatedAt = new Date();
        await userRepository.save(user);

        return sendResponse(res, true, 200, 'Password changed successfully', {
            mustChangePassword: false,
            passwordChangedAt: (user as any).passwordChangedAt,
        });
    } catch (error) {
        return sendResponse(res, false, 500, 'Internal server error');
    }
};


// ... existing code ...

/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Delete a user
 *     tags: [Auth]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The user ID
 *     responses:
 *       204:
 *         description: User deleted successfully
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
export const deleteUser = async (req: Request, res: Response) => {
    const userRepository = AppDataSource.getRepository(SystemUsers);
    const username = req.params.username;

    try {
        const user = await userRepository.findOne({ where: { username: username } });
        if (!user) {
            return sendResponse(res, false, 404, 'User not found');
        }

        await writeAuditLog({
            req,
            action: "admin.authUsers.delete",
            targetUsernames: [user.username],
            meta: { deletedUserId: user.id, role: user.role },
        });
        await userRepository.remove(user);
        sendResponse(res, true, 204, 'User deleted successfully');
    } catch (error) {
        sendResponse(res, false, 500, 'Internal server error');
    }
};

// ... existing code ...