#include <stdio.h>

static int net_weight(int gross, int container) {
    return gross - container;
}

int main(void) {
    int gross;
    int container;
    if (scanf("%d %d", &gross, &container) != 2) {
        return 1;
    }
    printf("%d\n", net_weight(gross));
    return 0;
}
