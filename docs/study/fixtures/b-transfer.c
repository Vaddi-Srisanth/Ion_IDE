#include <stdio.h>

int main(void) {
    int available;
    int change;
    if (scanf("%d %d", &available, &change) != 2) {
        return 1;
    }
    const int *stock = &available;
    const int updated = **stock + change;
    printf("%d\n", updated);
    return 0;
}
