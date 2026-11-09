#include <stdio.h>

static int corrected_reading(int reading, int offset) {
    return reading + offset;
}

int main(void) {
    int reading;
    int offset;
    if (scanf("%d %d", &reading, &offset) != 2) {
        return 1;
    }
    printf("%d\n", corrected_reading(reading, *offset));
    return 0;
}
