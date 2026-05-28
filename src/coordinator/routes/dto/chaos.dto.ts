import type { ChaosAction, ChaosState } from "../../services/chaos.service";

export interface ChaosRequestDto {
	/** Spec-mandated field name: "fault" */
	fault: ChaosAction;
	/** Fault-specific parameters, e.g. { ms: 5000 }, { count: 3 }, { offsetSeconds: -30 } */
	params?: Record<string, number>;
}

export interface ChaosResponseDto extends ChaosState {}
