import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { ResponseCode } from "../../shared/errors";
import { makeResponse } from "../response";

function mockRes() {
	const r: Partial<Response> = {};
	r.status = vi.fn().mockReturnThis() as Response["status"];
	r.json = vi.fn().mockReturnThis() as Response["json"];
	return r as Response;
}

describe("makeResponse", () => {
	it("emits {success, code, message} envelope on success", () => {
		const res = mockRes();
		makeResponse(res, 200, true, "ok");
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			success: true,
			code: ResponseCode.OK,
			message: "ok",
		});
	});

	it("defaults to INTERNAL_ERROR code when failure and no code given", () => {
		const res = mockRes();
		makeResponse(res, 500, false, "boom");
		expect(res.json).toHaveBeenCalledWith({
			success: false,
			code: ResponseCode.INTERNAL_ERROR,
			message: "boom",
		});
	});

	it("spreads payload fields onto the envelope", () => {
		const res = mockRes();
		makeResponse(res, 201, true, "created", { job_id: "abc-123" });
		expect(res.json).toHaveBeenCalledWith({
			success: true,
			code: ResponseCode.OK,
			message: "created",
			job_id: "abc-123",
		});
	});

	it("respects an explicit code over the success default", () => {
		const res = mockRes();
		makeResponse(res, 404, false, "missing", null, ResponseCode.NOT_FOUND);
		expect(res.json).toHaveBeenCalledWith({
			success: false,
			code: ResponseCode.NOT_FOUND,
			message: "missing",
		});
	});

	it("passes the HTTP status code unchanged", () => {
		const res = mockRes();
		makeResponse(res, 422, false, "bad", null, ResponseCode.VALIDATION_ERROR);
		expect(res.status).toHaveBeenCalledWith(422);
	});
});
