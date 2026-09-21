import type { CalendarEvent } from './types';
import { localTime } from './dates';
export type WeekBlock = {
	event: CalendarEvent;
	top: number;
	height: number;
	lane: number;
	lanes: number;
};
export function weekBlocks(events: CalendarEvent[], day: string, zone: string): WeekBlock[] {
	const minutes = (value: string) => Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
	const blocks = events
		.filter((e) => !e.allDay)
		.flatMap((event) => {
			const start = localTime(event.startsAt, zone),
				end = localTime(event.endsAt, zone);
			if (start.slice(0, 10) > day || end.slice(0, 10) < day || end === `${day}T00:00`) return [];
			const top = start.slice(0, 10) < day ? 0 : minutes(start);
			const bottom = end.slice(0, 10) > day ? 1440 : minutes(end);
			return [{ event, top, height: Math.max(24, bottom - top), lane: 0, lanes: 1 }];
		})
		.sort((a, b) => a.top - b.top || b.height - a.height);
	let cluster: WeekBlock[] = [],
		laneEnds: number[] = [],
		clusterEnd = -1;
	const finish = () => {
		for (const block of cluster) block.lanes = laneEnds.length;
		cluster = [];
		laneEnds = [];
	};
	for (const block of blocks) {
		if (block.top >= clusterEnd) finish();
		let lane = laneEnds.findIndex((end) => end <= block.top);
		if (lane < 0) lane = laneEnds.length;
		block.lane = lane;
		laneEnds[lane] = block.top + block.height;
		clusterEnd = Math.max(...laneEnds);
		cluster.push(block);
	}
	finish();
	return blocks;
}
