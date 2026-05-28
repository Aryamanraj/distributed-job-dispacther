import type { ChaosAction, ChaosState } from "../../services/chaos.service";

export interface ChaosRequestDto {
	action: ChaosAction;
	value?: number;
}

export interface ChaosResponseDto extends ChaosState {}
