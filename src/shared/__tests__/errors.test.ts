import { describe, expect, it } from "vitest";
import { GenericError, ResponseCode } from "../errors";

describe("GenericError", () => {
	it("captures message, status, and code", () => {
		const e = new GenericError("not found", 404, ResponseCode.NOT_FOUND);
		expect(e.message).toBe("not found");
		expect(e.status).toBe(404);
		expect(e.code).toBe(ResponseCode.NOT_FOUND);
	});

	it("defaults code to INTERNAL_ERROR when not specified", () => {
		const e = new GenericError("boom", 500);
		expect(e.code).toBe(ResponseCode.INTERNAL_ERROR);
	});

	it("is an instance of Error and has the right name", () => {
		const e = new GenericError("x", 400, ResponseCode.VALIDATION_ERROR);
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("GenericError");
	});

	it("can be caught as Error", () => {
		try {
			throw new GenericError("oops", 418, ResponseCode.VALIDATION_ERROR);
		} catch (err) {
			expect(err).toBeInstanceOf(GenericError);
			expect((err as GenericError).status).toBe(418);
		}
	});
});

describe("ResponseCode", () => {
	it("includes all wire codes used by route handlers", () => {
		// Wire-contract regression: each of these is checked by clients/tests
		// somewhere by string value; renaming = breaking change.
		expect(ResponseCode.OK).toBe("OK");
		expect(ResponseCode.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
		expect(ResponseCode.NOT_FOUND).toBe("NOT_FOUND");
		expect(ResponseCode.JOB_CREATED).toBe("JOB_CREATED");
		expect(ResponseCode.JOB_DUPLICATE).toBe("JOB_DUPLICATE");
		expect(ResponseCode.JOB_NOT_FOUND).toBe("JOB_NOT_FOUND");
		expect(ResponseCode.JOB_ALREADY_TERMINAL).toBe("JOB_ALREADY_TERMINAL");
		expect(ResponseCode.JOB_CANCELLED).toBe("JOB_CANCELLED");
	});
});
