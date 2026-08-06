/**
 * Hermetic color env for the unit suite.
 *
 * Agent/CI shells often export NO_COLOR=1 and FORCE_COLOR=0. Theme.fg/bg now
 * honor those (ColorMode "none"), which would make every UI color assert see
 * plain text. Clear the kill switches so Theme uses truecolor/256 from caps;
 * silence chalk styles separately via chalk.level so bold/inverse still don't
 * inject SGR into substring matches. Dedicated tests re-set NO_COLOR/FORCE_COLOR
 * when they need mono behavior.
 */
import chalk from "chalk";

delete process.env.NO_COLOR;
delete process.env.FORCE_COLOR;
chalk.level = 0;
