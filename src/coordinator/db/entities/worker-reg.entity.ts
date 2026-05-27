import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("WorkerReg")
export class WorkerReg {
	@PrimaryColumn({ name: "WorkerID", type: "text" })
	WorkerID: string;

	@Column({ name: "ConcurrencyLimit", type: "int", default: 8 })
	ConcurrencyLimit: number;

	@Column({ name: "ConnectedAt", type: "timestamptz", default: () => "now()" })
	ConnectedAt: Date;

	@Column({ name: "LastSeenAt", type: "timestamptz", default: () => "now()" })
	LastSeenAt: Date;
}
