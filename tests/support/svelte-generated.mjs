// Kit 3's runtime imports the generated app hooks even when testing only its
// cookie serializer outside an application. No app hooks are needed here.
export async function get_hooks() {
	return {};
}
