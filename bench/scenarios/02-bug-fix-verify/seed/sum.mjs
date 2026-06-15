// Returns the sum of all numbers in the array.
export function sumArray(nums) {
	let total = 0;
	for (let i = 1; i < nums.length; i++) {
		total += nums[i];
	}
	return total;
}
