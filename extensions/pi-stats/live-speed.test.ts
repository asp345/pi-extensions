import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveTokenSpeed } from "./live-speed.ts";

test("averages only continuous token emission intervals", () => {
	const speed = new ActiveTokenSpeed();
	for (let second = 0; second <= 10; second++) speed.add(40, second * 1_000);
	assert.equal(speed.getSpeed(), 40);
});

test("starts a new measurement after an idle gap", () => {
	const speed = new ActiveTokenSpeed({ minimumActiveMs: 500 });
	speed.add(100, 0);
	speed.add(100, 1_000);
	speed.add(25, 5_000);
	speed.add(25, 5_500);
	assert.equal(speed.getSpeed(), 50);
});

test("requires enough active emission time", () => {
	const speed = new ActiveTokenSpeed();
	speed.add(20, 0);
	speed.add(20, 500);
	assert.equal(speed.getSpeed(), null);
});
