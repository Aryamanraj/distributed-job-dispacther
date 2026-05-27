export enum ResponseCode {
	OK = "OK",
	INTERNAL_ERROR = "INTERNAL_ERROR",
	VALIDATION_ERROR = "VALIDATION_ERROR",
	NOT_FOUND = "NOT_FOUND",
	JOB_CREATED = "JOB_CREATED",
	JOB_DUPLICATE = "JOB_DUPLICATE",
	JOB_NOT_FOUND = "JOB_NOT_FOUND",
	JOB_ALREADY_TERMINAL = "JOB_ALREADY_TERMINAL",
	JOB_CANCELLED = "JOB_CANCELLED",
}

export class GenericError extends Error {
	status: number;
	code: ResponseCode;

	constructor(
		message: string,
		status: number,
		code = ResponseCode.INTERNAL_ERROR,
	) {
		super(message);
		this.name = "GenericError";
		this.status = status;
		this.code = code;
	}
}
