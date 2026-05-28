import { Router } from "express";
import { ResponseCode } from "../../shared/errors";
import { makeResponse } from "../../util/response";
import type { ChaosService } from "../services/chaos.service";
import { ChaosAction } from "../services/chaos.service";
import type { ChaosRequestDto } from "./dto/chaos.dto";

const VALID_FAULTS = new Set<string>(Object.values(ChaosAction));

export function createChaosRouter(chaos: ChaosService): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		makeResponse(
			res,
			200,
			true,
			"chaos state",
			chaos.getState(),
			ResponseCode.OK,
		);
	});

	// Spec body: { "fault": "pause_dispatch", "params": { "ms": 5000 } }
	router.post("/", (req, res) => {
		const { fault, params = {} } = req.body as ChaosRequestDto;

		if (typeof fault !== "string" || !VALID_FAULTS.has(fault)) {
			makeResponse(
				res,
				400,
				false,
				`invalid fault — must be one of: ${[...VALID_FAULTS].join(", ")}`,
				null,
				ResponseCode.VALIDATION_ERROR,
			);
			return;
		}

		chaos.apply(fault as ChaosAction, params);
		makeResponse(
			res,
			200,
			true,
			"chaos applied",
			chaos.getState(),
			ResponseCode.OK,
		);
	});

	return router;
}
