import type { Response } from "express";
import { ResponseCode } from "../shared/errors";

export const makeResponse = (
	res: Response,
	statusCode: number,
	success: boolean,
	message: string,
	payload: object | null = null,
	code: ResponseCode = success ? ResponseCode.OK : ResponseCode.INTERNAL_ERROR,
): void => {
	res.status(statusCode).json({ success, code, message, ...(payload ?? {}) });
};
