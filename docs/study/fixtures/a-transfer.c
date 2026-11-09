#include <stdio.h>

static int total_points(int tasks, int points_each) {
    return tasks * points_each;
}

int main(void) {
    int tasks;
    int points_each;
    if (scanf("%d %d", &tasks, &points_each) != 2) {
        return 1;
    }
    const int points = total_points(tasks, points_each, 0);
    printf("%d\n", points);
    return 0;
}
