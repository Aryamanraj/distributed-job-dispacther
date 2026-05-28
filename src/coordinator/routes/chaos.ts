import { Router } from "express";
import { ResponseCode } from "../../shared/errors";
import { makeResponse } from "../../util/response";
import type { ChaosService } from "../services/chaos.service";
import { ChaosAction } from "../services/chaos.service";
import type { ChaosRequestDto } from "./dto/chaos.dto";

const VALID_ACTIONS = new Set<string>(Object.values(ChaosAction));

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

	router.post("/", (req, res) => {
		const { action, value } = req.body as ChaosRequestDto;

		if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
			makeResponse(
				res,
				400,
				false,
				`invalid action — must be one of: ${[...VALID_ACTIONS].join(", ")}`,
				null,
				ResponseCode.VALIDATION_ERROR,
			);
			return;
		}

		chaos.apply(action as ChaosAction, typeof value === "number" ? value : 0);
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
