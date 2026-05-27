import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("IX_JobEvents_Ts", ["Ts"])
@Entity("JobEvents")
export class JobEvent {
	// BIGSERIAL — pg driver returns bigint as string
	@PrimaryGeneratedColumn({ name: "EventID", type: "bigint" })
	EventID: string;

	@Column({ name: "JobID", type: "uuid", nullable: true })
	JobID: string;

	// submitted | completed | failed
	@Column({ name: "Event", type: "text" })
	Event: string;

	@Column({ name: "Ts", type: "timestamptz", default: () => "now()" })
	Ts: Date;
}
